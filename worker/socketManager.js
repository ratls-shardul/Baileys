const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
  require("@whiskeysockets/baileys")
const Pino = require("pino")

const { clearSession } = require("./sessionUtils")
const { STATES, setClientState, removeClientState } = require("./clientState")
const Redis = require("ioredis")
const { sendMessageWithMedia } = require("./mediaSender")
const { info, warn, error, debug, clientLog } = require("./logger")

const WA_DEVICE_NAME = process.env.WA_DEVICE_NAME || "Admissions - CRM"
const WA_DEVICE_PLATFORM = process.env.WA_DEVICE_PLATFORM || "Linux"
const WA_DEVICE_VERSION = process.env.WA_DEVICE_VERSION || "120.0.0"

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

redis.on('error', (err) => error('❌ Redis error:', err.message))
redisPub.on('error', (err) => error('❌ Redis PUB error:', err.message))

// Function to ensure fresh Redis connection for publishing
async function ensurePublishConnection() {
  try {
    await redisPub.ping()
    return redisPub
  } catch (err) {
    warn('⚠️ Redis PUB connection failed, creating new one...')
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
const senderStopFlags = new Map()
const senderRedisClients = new Map()
const initializingClients = new Set()
const reconnectAttempts = new Map()
const recentNewLoginAt = new Map()
const stoppedClients = new Set()

async function markActive(clientId) {
  try {
    await redis.sadd("wa:clients:active", clientId)
  } catch {}
}

async function markInactive(clientId) {
  try {
    await redis.srem("wa:clients:active", clientId)
  } catch {}
}


// let isBooting = true
// const bootingClients = new Set()

async function publishEvent(event) {
  const startTime = Date.now()
  info("📤 PUBLISHING EVENT to stream:", event)
  
  try {
    // Ensure we have a working connection
    const pubClient = await ensurePublishConnection()
    
    // Test Redis connection first
    try {
      const pingStart = Date.now()
      await pubClient.ping()
      info(`   ✅ Redis PING ok (${Date.now() - pingStart}ms)`)
    } catch (pingErr) {
      error(`   ❌ Redis PING failed:`, pingErr.message)
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
    info(`✅ Event published to stream in ${duration}ms, Message ID: ${messageId}`)
    return messageId
  } catch (err) {
    const duration = Date.now() - startTime
    error(`❌ Failed to publish event to stream after ${duration}ms:`, err.message)
    error("   Event was:", JSON.stringify(event))
    
    // Don't throw - return null to prevent crashes
    return null
  }
}

async function initClient(clientId) {

  if (initializingClients.has(clientId)) {
    clientLog(clientId, "info", `⏳ already initializing`)
    return
  }

  stoppedClients.delete(clientId)
  initializingClients.add(clientId)

  try{
  // bootingClients.add(clientId)
    await setClientState(clientId, STATES.CONNECTING)

    if (sockets.has(clientId)) {
      clientLog(clientId, "warn", `⚠️ already initialized`)
      return sockets.get(clientId)
    }

    const sessionPath = `/sessions/${clientId}`

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

    const { version, isLatest } = await fetchLatestBaileysVersion()
    clientLog(clientId, "info", `📦 Baileys WA version: ${version.join(".")} (isLatest=${isLatest})`)

    const sock = makeWASocket({
      auth: state,
      // logger: Pino({ level: "debug" }),
      logger: Pino({ level: "silent" }).child({level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      version,
      browser: [WA_DEVICE_NAME, WA_DEVICE_PLATFORM, WA_DEVICE_VERSION]
    })

    sockets.set(clientId, sock)
    await markActive(clientId)

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
      try {
        clientLog(clientId, "debug", `📡 connection.update`, update)

        const { connection, qr, lastDisconnect, isNewLogin } = update

      if (isNewLogin) {
        recentNewLoginAt.set(clientId, Date.now())
      }

      if (qr) {
        await setClientState(clientId, STATES.QR_REQUIRED)
        await redis.set(`wa:qr:${clientId}`, qr, "EX", 120)
        
        // Try to publish, retry once if fails
        let published = await publishEvent({ type: "qr", clientId, qr })
        if (!published) {
          clientLog(clientId, "warn", "   Retrying QR publish...")
          await sleep(500)
          published = await publishEvent({ type: "qr", clientId, qr })
        }
        
        if (published) {
          clientLog(clientId, "info", "   ✅ QR published successfully")
        } else {
          clientLog(clientId, "error", "   ❌ QR publish failed after retry")
        }
      }

      if (connection === "open") {
        clientLog(clientId, "info", "🟢 connection opened")
        reconnectAttempts.delete(clientId)
        recentNewLoginAt.delete(clientId)

        await setClientState(clientId, STATES.CONNECTED)

        await redis.del(`wa:qr:${clientId}`)

        await publishEvent({
          type: "status",
          clientId,
          state: "CONNECTED"
        })

        connectedClients.add(clientId)

        // bootingClients.delete(clientId)

        clientLog(clientId, "info", "✅ connected successfully")

        setTimeout(() => {
          startSenderLoop(clientId)
        }, 2000)

        return
      }

      if (connection === "close") {
        connectedClients.delete(clientId)

        if (stoppedClients.has(clientId)) {
          await setClientState(clientId, STATES.STOPPED)
          await publishEvent({
            type: "status",
            clientId,
            state: "STOPPED"
          })

          const oldSock = sockets.get(clientId)
          if (oldSock) {
            oldSock.ev.removeAllListeners()
            try { oldSock.end() } catch {}
          }

          sockets.delete(clientId)
          await markInactive(clientId)
          await markInactive(clientId)
          return
        }
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.output?.payload?.statusCode
        const sawRecentNewLogin =
          Date.now() - (recentNewLoginAt.get(clientId) || 0) < 60_000

        // if (statusCode === undefined && bootingClients.has(clientId)) {
        //   console.log(`🟡 ${clientId} waiting for QR...`)
        //   return
        // }

        clientLog(clientId, "warn", `❌ disconnected (${statusCode})`)

        // 🚪 Logged out / Unauthorized
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          reconnectAttempts.delete(clientId)
          recentNewLoginAt.delete(clientId)
          await setClientState(clientId, STATES.LOGGED_OUT)

          // Publish LOGGED_OUT event (won't throw on failure)
          const publishResult = await publishEvent({
            type: "status",
            clientId,
            state: "LOGGED_OUT"
          })
          
          if (publishResult) {
            clientLog(clientId, "info", "✅ LOGGED_OUT event successfully published")
          } else {
            clientLog(clientId, "error", "⚠️ LOGGED_OUT event failed to publish - continuing anyway")
          }

          const oldSock = sockets.get(clientId)

          if (oldSock) {
            oldSock.ev.removeAllListeners()
            try { oldSock.end() } catch {}
          }

          sockets.delete(clientId)
          await markInactive(clientId)
          clearSession(clientId)

          clientLog(clientId, "info", "📲 requires new QR")

          // Auto reinitialize so the same client gets a fresh QR.
          setTimeout(async () => {
            clientLog(clientId, "info", "🔄 Reinitializing for new QR")
            await initClient(clientId)
          }, 1500)

          return
        }

        // Baileys often emits 515 ("restart required") right after QR scan/new login.
        // Treat this as an expected handover, not a hard disconnect.
        if (statusCode === 515 && sawRecentNewLogin) {
          await setClientState(clientId, STATES.CONNECTING)
          await publishEvent({
            type: "status",
            clientId,
            state: "CONNECTING"
          })

          const oldSock = sockets.get(clientId)
          if (oldSock) {
            oldSock.ev.removeAllListeners()
            try { oldSock.end() } catch {}
          }
          sockets.delete(clientId)

          clientLog(clientId, "info", "🔁 got post-login 515; restarting socket without session reset")
          setTimeout(() => {
            initClient(clientId)
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
        await markInactive(clientId)

        const attempt = (reconnectAttempts.get(clientId) || 0) + 1
        reconnectAttempts.set(clientId, attempt)

        // Cap auto-retries to avoid infinite tight loops.
        if (attempt > 8) {
          clientLog(clientId, "error", `🛑 exceeded reconnect attempts (${attempt - 1}), waiting for manual reconnect`)
          return
        }

        // Only force fresh session for non-405 disconnects.
        if (statusCode !== 405) {
          clearSession(clientId)
        } else {
          clientLog(clientId, "warn", "⚠️ got 405; preserving session to avoid QR/reset loop")
        }

        const delayMs = statusCode === 405
          ? Math.min(15000 * attempt, 120000)
          : Math.min(3000 * attempt, 30000)

        setTimeout(() => {
          clientLog(clientId, "info", `🔄 Reinitializing (attempt ${attempt}, delay ${delayMs}ms)...`)
          initClient(clientId)
        }, delayMs)
      }
      } catch (connUpdateErr) {
        clientLog(clientId, "error", `❌ Error in connection.update handler: ${connUpdateErr.message}`)
        clientLog(clientId, "error", `   Stack: ${connUpdateErr.stack}`)
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
  senderStopFlags.set(clientId, false)
  clientLog(clientId, "info", "▶️ Sender loop started")

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
    clientLog(clientId, "error", `❌ Queue Redis error: ${err.message}`)
  })

  while (true) {
    try {
      if (senderStopFlags.get(clientId)) {
        break
      }
      const sock = sockets.get(clientId)
      if (!sock || !connectedClients.has(clientId)) {
        // Do not dequeue while client is disconnected/uninitialized.
        await sleep(2000)
        continue
      }

      // 🔑 BLOCK until a message arrives (one-at-a-time processing)
      const res = await queueRedis.brpop(`wa:pending:${clientId}`, 0)
      const raw = res[1]
      const payload = JSON.parse(raw)

      const phone = payload.phoneNumber.toString()

      const jid = phone.includes("@s.whatsapp.net")
        ? phone
        : `91${phone}@s.whatsapp.net`

      clientLog(clientId, "info", `📤 Sending → ${payload.phoneNumber}`)
      try {
        await sendMessageWithMedia(sock, jid, payload)
      } catch (sendErr) {
        clientLog(clientId, "error", `❌ Send failed, re-queueing: ${sendErr && sendErr.message ? sendErr.message : sendErr}`)
        // Push back to the right so it stays the next item to retry (FIFO-safe retry).
        await queueRedis.rpush(`wa:pending:${clientId}`, raw)
        await sleep(3000)
        continue
      }

      // 🎲 RANDOM DELAY AFTER SEND
      await sleep(randomBetween(2000, 5000))
    } catch (err) {
      if (senderStopFlags.get(clientId)) {
        break
      }
      clientLog(clientId, "error", `❌ Sender loop error: ${err && err.message ? err.message : err}`)
      await sleep(5000)
    }
  }

  senderLoops.delete(clientId)
  senderStopFlags.delete(clientId)
  senderRedisClients.delete(clientId)
}

function getClient(clientId) {
  return sockets.get(clientId)
}

function listClients() {
  return [...sockets.keys()]
}

function stopSenderLoop(clientId) {
  senderStopFlags.set(clientId, true)
  const queueRedis = senderRedisClients.get(clientId)
  if (queueRedis) {
    try { queueRedis.disconnect() } catch {}
  }
}

async function restartClient(clientId, { resetSession = false } = {}) {
  connectedClients.delete(clientId)
  reconnectAttempts.delete(clientId)
  recentNewLoginAt.delete(clientId)
  stoppedClients.delete(clientId)
  stopSenderLoop(clientId)

  const oldSock = sockets.get(clientId)
  if (oldSock) {
    oldSock.ev.removeAllListeners()
    try { oldSock.end() } catch {}
  }

  sockets.delete(clientId)
  await markInactive(clientId)

  if (resetSession) {
    clearSession(clientId)
  }

  await setClientState(clientId, STATES.CONNECTING)
  await publishEvent({
    type: "status",
    clientId,
    state: "CONNECTING"
  })

  clientLog(clientId, "info", `🔁 restart requested (resetSession=${resetSession})`)
  await initClient(clientId)
}

async function stopClient(clientId, { resetSession = false } = {}) {
  stoppedClients.add(clientId)
  connectedClients.delete(clientId)
  reconnectAttempts.delete(clientId)
  recentNewLoginAt.delete(clientId)
  stopSenderLoop(clientId)

  const oldSock = sockets.get(clientId)
  if (oldSock) {
    oldSock.ev.removeAllListeners()
    try { oldSock.end() } catch {}
  }

  sockets.delete(clientId)
  await markInactive(clientId)

  if (resetSession) {
    clearSession(clientId)
  }

  await setClientState(clientId, STATES.STOPPED)
  await publishEvent({
    type: "status",
    clientId,
    state: "STOPPED"
  })

  clientLog(clientId, "info", `⏹️ stop requested (resetSession=${resetSession})`)
}

async function deleteClient(clientId) {
  stoppedClients.add(clientId)
  connectedClients.delete(clientId)
  reconnectAttempts.delete(clientId)
  recentNewLoginAt.delete(clientId)
  stopSenderLoop(clientId)

  const oldSock = sockets.get(clientId)
  if (oldSock) {
    oldSock.ev.removeAllListeners()
    try { oldSock.end() } catch {}
  }

  sockets.delete(clientId)
  await markInactive(clientId)

  try {
    await redis.del(`wa:qr:${clientId}`)
    await redis.del(`wa:pending:${clientId}`)
    await removeClientState(clientId)
  } catch {}

  clearSession(clientId)

  await publishEvent({
    type: "status",
    clientId,
    state: "DELETED"
  })

  clientLog(clientId, "warn", "🧨 deleted client state + session")
}

module.exports = {
  initClient,
  getClient,
  listClients,
  startSenderLoop,
  restartClient,
  stopClient,
  deleteClient
}
