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
const connectedClients = new Set()
const senderLoops = new Set()


// let isBooting = true
// const bootingClients = new Set()

function publishEvent(event) {
  console.log("PUBLISHING EVENT:", event)
  redis.publish("wa:events", JSON.stringify(event))
}

async function initClient(clientId) {
  // bootingClients.add(clientId)
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
    logger: Pino({ level: "silent" }).child({level: "silent" }),
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

      // ✅ Save QR (important)
      await redis.set(`wa:qr:${clientId}`, qr, "EX", 120)

      publishEvent({
        type: "qr",
        clientId,
        qr
      })

      // bootingClients.delete(clientId)
      return
    }

    if (connection === "open") {
      console.log(`🟢 ${clientId} connection opened`)

      await setClientState(clientId, STATES.CONNECTED)

      await redis.del(`wa:qr:${clientId}`)

      publishEvent({
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
        await setClientState(clientId, STATES.LOGGED_OUT)

        publishEvent({
          type: "status",
          clientId,
          state: "LOGGED_OUT"
        })

        const oldSock = sockets.get(clientId)

        if (oldSock) {
          oldSock.ev.removeAllListeners()
          try { oldSock.end() } catch {}
        }

        sockets.delete(clientId)
        clearSession(clientId)

        console.log(`📲 ${clientId} requires new QR`)
        // bootingClients.delete(clientId)

        // 🔥 Auto re-init to generate new QR
        setTimeout(() => {
          console.log(`🔄 Reinitializing ${clientId} for new QR`)
          initClient(clientId)
        }, 1000)

        return
      }

      // 🌐 Transient disconnect
      await setClientState(clientId, STATES.DISCONNECTED)
      publishEvent({
        type: "status",
        clientId,
        state: "DISCONNECTED"
      })

      sockets.delete(clientId)

      setTimeout(() => {
        console.log(`🔄 Reconnecting ${clientId}...`)
        initClient(clientId)
      }, 5000)
    }
  })

  console.log('sockets after update: ',sockets)
  return sock
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

  while (true) {
    try {
      // 🔑 BLOCK until a message arrives
      const res = await redis.brpop(`wa:pending:${clientId}`, 0)
      const raw = res[1]
      const payload = JSON.parse(raw)

      const sock = sockets.get(clientId)
      if (!sock) {
        console.log(`⏸️ ${clientId} socket missing, re-queueing`)
        await redis.lpush(`wa:pending:${clientId}`, raw)
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
