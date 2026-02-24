const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
  require("@whiskeysockets/baileys")
const Pino = require("pino")

const { clearSession } = require("./sessionUtils")
const { STATES, setClientState } = require("./clientState")
const Redis = require("ioredis")
const { sendMessageWithMedia } = require("./mediaSender")

// Separate Redis connections to prevent blocking
const redis = new Redis({
  host: "redis",
  port: 6379,
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3
})

// Separate connection for publishing (non-blocking)
let redisPub = new Redis({
  host: "redis",
  port: 6379,
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3
})

redis.on('error', (err) => console.error('❌ Redis error:', err.message))
redisPub.on('error', (err) => console.error('❌ Redis PUB error:', err.message))

// Function to ensure fresh Redis connection for publishing
async function ensurePublishConnection() {
  try {
    await redisPub.ping()
    return redisPub
  } catch (err) {
    console.warn('⚠️ Redis PUB connection failed, creating new one...')
    redisPub.disconnect()
    redisPub = new Redis({
      host: "redis",
      port: 6379,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      commandTimeout: 5000
    })
    await redisPub.ping()
    return redisPub
  }
}

const sockets = new Map()
const connectedClients = new Set()
const senderLoops = new Set()
const senderRedisClients = new Map()
const initializingClients = new Set()
const reconnectAttempts = new Map()


// let isBooting = true
// const bootingClients = new Set()

async function publishEvent(event) {
  const startTime = Date.now()
  console.log("📤 PUBLISHING EVENT to stream:", event)
  
  try {
    // Ensure we have a working connection
    const pubClient = await ensurePublishConnection()
    
    // Test Redis connection first
    try {
      const pingStart = Date.now()
      await pubClient.ping()
      console.log(`   ✅ Redis PING ok (${Date.now() - pingStart}ms)`)
    } catch (pingErr) {
      console.error(`   ❌ Redis PING failed:`, pingErr.message)
      return null // Don't crash, just return null
    }
    
    // Use dedicated publish connection to avoid blocking
    const publishPromise = pubClient.xadd(
      'wa:events:stream',  // Stream key
      '*',                 // Auto-generate ID (timestamp-based)
      'data', JSON.stringify(event)  // Store event as JSON
    )
    
    // Race between publish and 10-second timeout (increased from 3s)
    const messageId = await Promise.race([
      publishPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Publish timeout after 10s`)), 10000)
      )
    ])
    
    const duration = Date.now() - startTime
    console.log(`✅ Event published to stream in ${duration}ms, Message ID: ${messageId}`)
    return messageId
  } catch (err) {
    const duration = Date.now() - startTime
    console.error(`❌ Failed to publish event to stream after ${duration}ms:`, err.message)
    console.error("   Event was:", JSON.stringify(event))
    
    // Don't throw - return null to prevent crashes
    return null
  }
}

async function initClient(clientId) {

  if (initializingClients.has(clientId)) {
    console.log(`⏳ ${clientId} already initializing`)
    return
  }

  initializingClients.add(clientId)

  try{
  // bootingClients.add(clientId)
    await setClientState(clientId, STATES.CONNECTING)

    if (sockets.has(clientId)) {
      console.log(`⚠️ Client ${clientId} already initialized`)
      return sockets.get(clientId)
    }

    const sessionPath = `/sessions/${clientId}`

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`📦 Baileys WA version for ${clientId}: ${version.join(".")} (isLatest=${isLatest})`)

    const sock = makeWASocket({
      auth: state,
      // logger: Pino({ level: "debug" }),
      logger: Pino({ level: "silent" }).child({level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      version
    })

    sockets.set(clientId, sock)

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
      try {
        console.log(`📡 [${clientId}] connection.update`, JSON.stringify(update))

        const { connection, qr, lastDisconnect } = update

      if (qr) {
        await setClientState(clientId, STATES.QR_REQUIRED)
        await redis.set(`wa:qr:${clientId}`, qr, "EX", 120)
        
        // Try to publish, retry once if fails
        let published = await publishEvent({ type: "qr", clientId, qr })
        if (!published) {
          console.warn("   Retrying QR publish...")
          await sleep(500)
          published = await publishEvent({ type: "qr", clientId, qr })
        }
        
        if (published) {
          console.log("   ✅ QR published successfully")
        } else {
          console.error("   ❌ QR publish failed after retry")
        }
      }

      if (connection === "open") {
        console.log(`🟢 ${clientId} connection opened`)
        reconnectAttempts.delete(clientId)

        await setClientState(clientId, STATES.CONNECTED)

        await redis.del(`wa:qr:${clientId}`)

        await publishEvent({
          type: "status",
          clientId,
          state: "CONNECTED"
        })

        connectedClients.add(clientId)

        // bootingClients.delete(clientId)

        console.log(`✅ ${clientId} connected successfully`)

        setTimeout(() => {
          startSenderLoop(clientId)
        }, 2000)

        return
      }

      if (connection === "close") {
        connectedClients.delete(clientId)
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.output?.payload?.statusCode

        // if (statusCode === undefined && bootingClients.has(clientId)) {
        //   console.log(`🟡 ${clientId} waiting for QR...`)
        //   return
        // }

        console.log(`❌ ${clientId} disconnected (${statusCode})`)

        // 🚪 Logged out / Unauthorized
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          reconnectAttempts.delete(clientId)
          await setClientState(clientId, STATES.LOGGED_OUT)

          // Publish LOGGED_OUT event (won't throw on failure)
          const publishResult = await publishEvent({
            type: "status",
            clientId,
            state: "LOGGED_OUT"
          })
          
          if (publishResult) {
            console.log(`✅ LOGGED_OUT event successfully published for ${clientId}`)
          } else {
            console.error(`⚠️ LOGGED_OUT event failed to publish for ${clientId} - continuing anyway`)
          }

          const oldSock = sockets.get(clientId)

          if (oldSock) {
            oldSock.ev.removeAllListeners()
            try { oldSock.end() } catch {}
          }

          sockets.delete(clientId)
          clearSession(clientId)

          console.log(`📲 ${clientId} requires new QR`)

          // Auto reinitialize so the same client gets a fresh QR.
          setTimeout(async () => {
            console.log(`🔄 Reinitializing ${clientId} for new QR`)
            await initClient(clientId)
          }, 1500)

          return
        }

        // 🌐 Disconnected: retry with backoff.
        // For 405 connection failures, do NOT clear session each loop.
        await setClientState(clientId, STATES.DISCONNECTED)
        await publishEvent({
          type: "status",
          clientId,
          state: "DISCONNECTED"
        })

        const oldSock = sockets.get(clientId)
        if (oldSock) {
          oldSock.ev.removeAllListeners()
          try { oldSock.end() } catch {}
        }

        sockets.delete(clientId)

        const attempt = (reconnectAttempts.get(clientId) || 0) + 1
        reconnectAttempts.set(clientId, attempt)

        // Cap auto-retries to avoid infinite tight loops.
        if (attempt > 8) {
          console.error(`🛑 ${clientId} exceeded reconnect attempts (${attempt - 1}), waiting for manual reconnect`)
          return
        }

        // Only force fresh session for non-405 disconnects.
        if (statusCode !== 405) {
          clearSession(clientId)
        } else {
          console.warn(`⚠️ ${clientId} got 405; preserving session to avoid QR/reset loop`)
        }

        const delayMs = statusCode === 405
          ? Math.min(15000 * attempt, 120000)
          : Math.min(3000 * attempt, 30000)

        setTimeout(() => {
          console.log(`🔄 Reinitializing ${clientId} (attempt ${attempt}, delay ${delayMs}ms)...`)
          initClient(clientId)
        }, delayMs)
      }
      } catch (connUpdateErr) {
        console.error(`❌ Error in connection.update handler for ${clientId}:`, connUpdateErr.message)
        console.error(`   Stack:`, connUpdateErr.stack)
        // Don't crash - just log the error
      }
    })

    // console.log('sockets after update: ',sockets)
    return sock
  }finally {
      initializingClients.delete(clientId)
    }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function startSenderLoop(clientId) {
  if (senderLoops.has(clientId)) return

  senderLoops.add(clientId)
  console.log(`▶️ Sender loop started for ${clientId}`)

  // Dedicated Redis connection per sender loop.
  // BRPOP is a blocking command and must not share one connection across client loops.
  const queueRedis = new Redis({
    host: "redis",
    port: 6379,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null
  })
  senderRedisClients.set(clientId, queueRedis)
  queueRedis.on("error", (err) => {
    console.error(`❌ Queue Redis error for ${clientId}:`, err.message)
  })

  while (true) {
    try {
      // 🔑 BLOCK until a message arrives
      const res = await queueRedis.brpop(`wa:pending:${clientId}`, 0)
      const raw = res[1]
      const payload = JSON.parse(raw)

      const sock = sockets.get(clientId)
      if (!sock) {
        console.log(`⏸️ ${clientId} socket missing, re-queueing`)
        await queueRedis.lpush(`wa:pending:${clientId}`, raw)
        await sleep(3000)
        continue
      }

      const phone = payload.phoneNumber.toString()

      const jid = phone.includes("@s.whatsapp.net")
        ? phone
        : `91${phone}@s.whatsapp.net`

      console.log(`📤 Sending via ${clientId} → ${payload.phoneNumber}`)

      await sendMessageWithMedia(sock, jid, payload)

      // 🎲 RANDOM DELAY AFTER SEND
      await sleep(randomBetween(2000, 5000))
    } catch (err) {
      console.error(`❌ Sender loop error for ${clientId}`, err)
      await sleep(5000)
    }
  }
}

function getClient(clientId) {
  return sockets.get(clientId)
}

function listClients() {
  return [...sockets.keys()]
}

module.exports = {
  initClient,
  getClient,
  listClients,
  startSenderLoop
}
