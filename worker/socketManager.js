const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
  require("@whiskeysockets/baileys")
const Pino = require("pino")

const { clearSession } = require("./sessionUtils")
const { STATES, setClientState, removeClientState } = require("./clientState")
const Redis = require("ioredis")
const { sendMessageWithMedia } = require("./mediaSender")
const { info, warn, error, clientLog } = require("./logger")

const WA_DEVICE_NAME = process.env.WA_DEVICE_NAME || "Admissions - CRM"
const WA_DEVICE_PLATFORM = process.env.WA_DEVICE_PLATFORM || "Linux"
const WA_DEVICE_VERSION = process.env.WA_DEVICE_VERSION || "120.0.0"
const SEND_DELAY_CONFIG_KEY = "wa:config:sendDelay"
const DEFAULT_SEND_DELAY_MIN_MS = 3000
const DEFAULT_SEND_DELAY_MAX_MS = 8000
const MIN_ALLOWED_SEND_DELAY_MS = 500
const MAX_ALLOWED_SEND_DELAY_MS = 120000
const MSGLOG_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

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

// Bounded FIFO cache used for msgRetryCounterCache in each Baileys socket.
// Prevents unbounded growth of the default internal cache under high message volume.
class BoundedCache {
  constructor(maxSize = 500) {
    this._max = maxSize
    this._store = new Map()
  }
  get(key) { return this._store.get(key) }
  set(key, value) {
    if (this._store.size >= this._max) {
      this._store.delete(this._store.keys().next().value)
    }
    this._store.set(key, value)
  }
  del(key) { this._store.delete(key) }
  flushAll() { this._store.clear() }
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
const reconnectTimers = new Map()
const clientPinoLoggers = new Map()

function getOrCreateClientLogger(clientId) {
  if (!clientPinoLoggers.has(clientId)) {
    clientPinoLoggers.set(
      clientId,
      Pino({ level: "silent" }).child({ level: "silent" })
    )
  }
  return clientPinoLoggers.get(clientId)
}

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

function clearReconnectTimer(clientId) {
  const timer = reconnectTimers.get(clientId)
  if (timer) {
    clearTimeout(timer)
    reconnectTimers.delete(clientId)
  }
}

function scheduleReconnect(clientId, delayMs, task) {
  clearReconnectTimer(clientId)
  const timer = setTimeout(async () => {
    reconnectTimers.delete(clientId)
    try {
      await task()
    } catch (err) {
      clientLog(clientId, "error", `❌ Scheduled reconnect failed: ${err && err.message ? err.message : err}`)
    }
  }, delayMs)
  reconnectTimers.set(clientId, timer)
}

function teardownSocket(clientId) {
  const oldSock = sockets.get(clientId)
  if (oldSock) {
    oldSock.ev.removeAllListeners()
    try { oldSock.end() } catch {}
  }
  sockets.delete(clientId)
  connectedClients.delete(clientId)
}

async function publishEvent(event) {
  let timeoutId
  try {
    const pubClient = await ensurePublishConnection()
    const publishPromise = pubClient.xadd(
      'wa:events:stream',
      '*',
      'data', JSON.stringify(event)
    )

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Publish timeout after 10s`)), 10000)
    })
    const messageId = await Promise.race([publishPromise, timeoutPromise])

    return messageId
  } catch (err) {
    error(`❌ Failed to publish event to stream:`, err.message)
    return null
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

async function logMessage(clientId, entry) {
  try {
    const key = `wa:msglog:${clientId}`
    await redis.zadd(key, entry.sentAt, JSON.stringify(entry))
    const cutoff = Date.now() - MSGLOG_TTL_MS
    await redis.zremrangebyscore(key, '-inf', cutoff)
  } catch (err) {
    warn(`⚠️ Failed to write message log for ${clientId}: ${err && err.message ? err.message : err}`)
  }
}

async function initClient(clientId) {

  if (initializingClients.has(clientId)) {
    return
  }

  if (sockets.has(clientId)) {
    return sockets.get(clientId)
  }

  stoppedClients.delete(clientId)
  initializingClients.add(clientId)

  try{
  // bootingClients.add(clientId)
    await setClientState(clientId, STATES.CONNECTING)

    const sessionPath = `/sessions/${clientId}`

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      auth: state,
      logger: getOrCreateClientLogger(clientId),
      msgRetryCounterCache: new BoundedCache(500),
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
          await sleep(500)
          published = await publishEvent({ type: "qr", clientId, qr })
        }

        if (!published) {
          clientLog(clientId, "error", "   ❌ QR publish failed after retry")
        }
      }

      if (connection === "open") {
        clearReconnectTimer(clientId)
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

          clearReconnectTimer(clientId)
          teardownSocket(clientId)
          await markInactive(clientId)
          return
        }
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.output?.payload?.statusCode
        const sawRecentNewLogin =
          Date.now() - (recentNewLoginAt.get(clientId) || 0) < 60_000

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

          if (!publishResult) {
            clientLog(clientId, "error", "⚠️ LOGGED_OUT event failed to publish - continuing anyway")
          }

          clearReconnectTimer(clientId)
          teardownSocket(clientId)
          await markInactive(clientId)
          clearSession(clientId)

          // Auto reinitialize so the same client gets a fresh QR.
          scheduleReconnect(clientId, 1500, async () => {
            await initClient(clientId)
          })

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

          clearReconnectTimer(clientId)
          teardownSocket(clientId)

          scheduleReconnect(clientId, 1500, async () => {
            initClient(clientId)
          })
          return
        }

        // 🌐 Disconnected: retry with backoff.
        // For recoverable transport failures, preserve session to avoid forced QR churn.
        await setClientState(clientId, STATES.DISCONNECTED)
        await publishEvent({
          type: "status",
          clientId,
          state: "DISCONNECTED"
        })

        teardownSocket(clientId)
        await markInactive(clientId)

        const attempt = (reconnectAttempts.get(clientId) || 0) + 1
        reconnectAttempts.set(clientId, attempt)

        const isKnownRecoverableTransportDisconnect =
          statusCode === 405 ||
          statusCode === 408 ||
          statusCode === 428

        // Preserve the existing auth session for all reconnect attempts unless we
        // have explicit evidence of logout (handled above) or we hit the retry cap.
        // Clearing auth on ordinary disconnects causes unnecessary QR churn.
        if (attempt === 1) {
          if (isKnownRecoverableTransportDisconnect) {
            clientLog(
              clientId,
              "warn",
              `⚠️ got ${statusCode}; preserving session and retrying`
            )
          } else {
            clientLog(
              clientId,
              "warn",
              `⚠️ got ${statusCode}; retrying with existing session`
            )
          }
        }

        const delayMs = isKnownRecoverableTransportDisconnect
          ? Math.min(15000 * attempt, 120000)
          : Math.min(3000 * attempt, 30000)

        scheduleReconnect(clientId, delayMs, async () => {
          initClient(clientId)
        })
      }
      } catch (connUpdateErr) {
        clientLog(clientId, "error", `❌ Error in connection.update handler: ${connUpdateErr.message}`)
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

function normalizeSendDelayConfig(value) {
  const minMs = Number(value && value.minMs)
  const maxMs = Number(value && value.maxMs)

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    return null
  }

  const normalizedMin = Math.max(MIN_ALLOWED_SEND_DELAY_MS, Math.floor(minMs))
  const normalizedMax = Math.min(MAX_ALLOWED_SEND_DELAY_MS, Math.floor(maxMs))

  if (normalizedMax < normalizedMin) {
    return null
  }

  return {
    minMs: normalizedMin,
    maxMs: normalizedMax
  }
}

async function getSendDelayConfig() {
  try {
    const raw = await redis.get(SEND_DELAY_CONFIG_KEY)
    if (!raw) {
      return {
        minMs: DEFAULT_SEND_DELAY_MIN_MS,
        maxMs: DEFAULT_SEND_DELAY_MAX_MS
      }
    }

    const parsed = JSON.parse(raw)
    const normalized = normalizeSendDelayConfig(parsed)
    if (normalized) {
      return normalized
    }
  } catch (err) {
    warn(`⚠️ Failed to load send delay config, using defaults: ${err.message}`)
  }

  return {
    minMs: DEFAULT_SEND_DELAY_MIN_MS,
    maxMs: DEFAULT_SEND_DELAY_MAX_MS
  }
}

async function startSenderLoop(clientId) {
  if (senderLoops.has(clientId)) return

  senderLoops.add(clientId)
  senderStopFlags.set(clientId, false)

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

      try {
        await sendMessageWithMedia(sock, jid, payload)
        clientLog(clientId, "info", `sent -> ${payload.phoneNumber}`)
        await logMessage(clientId, {
          phoneNumber: String(payload.phoneNumber),
          sentAt: Date.now(),
          status: "sent",
          text: payload.text || null,
          fileCount: Array.isArray(payload.files) ? payload.files.length : 0
        })
      } catch (sendErr) {
        await logMessage(clientId, {
          phoneNumber: String(payload.phoneNumber),
          sentAt: Date.now(),
          status: "failed",
          text: payload.text || null,
          fileCount: Array.isArray(payload.files) ? payload.files.length : 0,
          failReason: sendErr && sendErr.message ? sendErr.message : String(sendErr)
        })
        clientLog(clientId, "error", `❌ Send failed, re-queueing: ${sendErr && sendErr.message ? sendErr.message : sendErr}`)
        // Push back to the right so it stays the next item to retry (FIFO-safe retry).
        await queueRedis.rpush(`wa:pending:${clientId}`, raw)
        await sleep(3000)
        continue
      }

      const sendDelay = await getSendDelayConfig()
      await sleep(randomBetween(sendDelay.minMs, sendDelay.maxMs))
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

function stopSenderLoop(clientId) {
  senderStopFlags.set(clientId, true)
  const queueRedis = senderRedisClients.get(clientId)
  if (queueRedis) {
    try { queueRedis.disconnect() } catch {}
  }
}

async function restartClient(clientId, { resetSession = false } = {}) {
  clearReconnectTimer(clientId)
  connectedClients.delete(clientId)
  reconnectAttempts.delete(clientId)
  recentNewLoginAt.delete(clientId)
  stoppedClients.delete(clientId)
  stopSenderLoop(clientId)

  teardownSocket(clientId)
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

  await initClient(clientId)
}

async function stopClient(clientId, { resetSession = false } = {}) {
  clearReconnectTimer(clientId)
  stoppedClients.add(clientId)
  connectedClients.delete(clientId)
  reconnectAttempts.delete(clientId)
  recentNewLoginAt.delete(clientId)
  stopSenderLoop(clientId)

  teardownSocket(clientId)
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
}

async function deleteClient(clientId) {
  clearReconnectTimer(clientId)
  stoppedClients.add(clientId)
  connectedClients.delete(clientId)
  reconnectAttempts.delete(clientId)
  recentNewLoginAt.delete(clientId)
  stopSenderLoop(clientId)

  teardownSocket(clientId)
  await markInactive(clientId)

  try {
    await redis.del(`wa:qr:${clientId}`)
    await redis.del(`wa:pending:${clientId}`)
    await removeClientState(clientId)
  } catch {}

  clearSession(clientId)
  clientPinoLoggers.delete(clientId)

  await publishEvent({
    type: "status",
    clientId,
    state: "DELETED"
  })

  clientLog(clientId, "warn", "🧨 deleted client state + session")
}

module.exports = {
  initClient,
  startSenderLoop,
  restartClient,
  stopClient,
  deleteClient,
  _test: {
    resetState() {
      sockets.clear()
      connectedClients.clear()
      senderLoops.clear()
      senderStopFlags.clear()
      senderRedisClients.forEach((client) => {
        try { client.disconnect() } catch {}
      })
      senderRedisClients.clear()
      initializingClients.clear()
      reconnectAttempts.clear()
      recentNewLoginAt.clear()
      stoppedClients.clear()
      reconnectTimers.forEach((timer) => clearTimeout(timer))
      reconnectTimers.clear()
      clientPinoLoggers.clear()
    },
    setConnectedSocket(clientId, sock) {
      sockets.set(clientId, sock)
      connectedClients.add(clientId)
    },
    stopSenderLoop
  }
}
