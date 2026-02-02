const { makeWASocket, useMultiFileAuthState, DisconnectReason } =
  require("@whiskeysockets/baileys")
const Pino = require("pino")
const qrcode = require("qrcode-terminal")

const { clearSession } = require("./sessionUtils")
const { STATES, setClientState } = require("./clientState")
const Redis = require("ioredis")
const { sendMessageWithMedia } = require("./mediaSender")
const { randomDelay } = require("./utils/delay")

const redis = new Redis({
  host: "redis",
  port: 6379
})

const sockets = new Map()
const sendingClients = new Set()
const connectedClients = new Set()

// let isBooting = true
const bootingClients = new Set()

async function initClient(clientId) {
  bootingClients.add(clientId)
  await setClientState(clientId, STATES.CONNECTING)
  if (sockets.has(clientId)) {
    console.log(`⚠️ Client ${clientId} already initialized`)
    return sockets.get(clientId)
  }

  const sessionPath = `/sessions/${clientId}`

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    auth: state,
    // logger: Pino({ level: "debug" }),
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ["Admissions - CRM", "Linux", "120.0.0"]
  })

    sock.ev.on("creds.update", saveCreds)

sock.ev.on("connection.update", async (update) => {
  console.log(`📡 [${clientId}] connection.update`, JSON.stringify(update))

  const { connection, qr, lastDisconnect } = update

  if (qr) {
    await setClientState(clientId, STATES.QR_REQUIRED)
    console.log(`\n📲 Scan QR for ${clientId}\n`)
    require("qrcode-terminal").generate(qr, { small: true })
    bootingClients.delete(clientId)
    return
  }

  if (connection === "open") {
    await setClientState(clientId, STATES.CONNECTED)
    connectedClients.add(clientId)

    console.log(`✅ ${clientId} connected`)
    bootingClients.delete(clientId)

    if (sendingClients.has(clientId)) {
      console.log(`⏳ ${clientId} already flushing messages`)
      return
    }

    sendingClients.add(clientId)

    const pendingKey = `wa:pending:${clientId}`

    try {
      while (true) {
        const msg = await redis.rpop(pendingKey)
        if (!msg) break

        const payload = JSON.parse(msg)
        const jid = `91${payload.phoneNumber}@s.whatsapp.net`

        console.log(`📤 Sending queued message via ${clientId}`)

        await sendMessageWithMedia(sock, jid, payload)
        await randomDelay(1500, 4000)
      }
    } catch (err) {
      console.error(`❌ Error while sending messages for ${clientId}`, err)
    } finally {
      sendingClients.delete(clientId)
    }
    startSenderLoop(clientId)
    return
  }

  if (connection === "close") {
    connectedClients.delete(clientId)
    sendingClients.delete(clientId)
    const statusCode =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.error?.output?.payload?.statusCode

    if (statusCode === undefined && bootingClients.has(clientId)) {
      console.log(`🟡 ${clientId} waiting for QR...`)
      return
    }

    console.log(`❌ ${clientId} disconnected (${statusCode})`)

    // 🚪 Logged out / Unauthorized
    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
      await setClientState(clientId, STATES.LOGGED_OUT)
      sockets.delete(clientId)
      clearSession(clientId)
      console.log(`📲 ${clientId} requires new QR`)
      return
    }

    // 🌐 Transient disconnect
    await setClientState(clientId, STATES.DISCONNECTED)
    sockets.delete(clientId)

    setTimeout(() => {
      console.log(`🔄 Reconnecting ${clientId}...`)
      initClient(clientId)
    }, 5000)
  }
})

  sockets.set(clientId, sock)
  return sock
}

async function startSenderLoop(clientId) {
  if (sendingClients.has(clientId)) return

  if (!connectedClients.has(clientId)) return

  const sock = sockets.get(clientId)
  if (!sock) return

  sendingClients.add(clientId)

  const pendingKey = `wa:pending:${clientId}`

  try {
    let isFirstMessage = true

    while (true) {
      const raw = await redis.rpop(pendingKey)
      if (!raw) break

      const payload = JSON.parse(raw)
      const jid = `91${payload.phoneNumber}@s.whatsapp.net`

      if (!isFirstMessage) {
        await randomDelay(1500, 4000)
      }

      isFirstMessage = false

      console.log(`📤 Sending message via ${clientId}`)
      await sendMessageWithMedia(sock, jid, payload)
    }
  } catch (err) {
    console.error(`❌ Sender loop error for ${clientId}`, err)
  } finally {
    sendingClients.delete(clientId)

    const remaining = await redis.llen(`wa:pending:${clientId}`)
    if (remaining > 0 && connectedClients.has(clientId)) {
      startSenderLoop(clientId)
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
