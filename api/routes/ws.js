const { register } = require("../wsHub")
const redis = require("../redis")
const { info, warn, error, debug } = require("../logger")

async function sendClientSnapshot(socket, clientId) {
  const state = await redis.hget("wa:clients:state", clientId)

  socket.send(JSON.stringify({
    type: "status",
    clientId,
    state: state || "NON_EXISTENT"
  }))

  debug(`📤 Sent status: ${state || "NON_EXISTENT"} for ${clientId}`)

  const qr = await redis.get(`wa:qr:${clientId}`)
  if (qr) {
    socket.send(JSON.stringify({
      type: "qr",
      clientId,
      qr
    }))
    debug(`📤 Sent QR for ${clientId}`)
  }
}

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, (socket, req) => {
    
    let registered = false
    let clientId = null
    let lastPing = Date.now()

    socket.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        
        if (!data.clientId) {
          warn("⚠️ Received message without clientId")
          return
        }

        clientId = data.clientId

        // Register socket on first message (including ping) so reconnects
        // that only send heartbeat messages still receive broadcasts.
        let justRegistered = false
        if (!registered) {
          register(clientId, socket)
          registered = true
          justRegistered = true
          info(`✅ WebSocket registered for ${clientId}`)
        }

        if (justRegistered) {
          await sendClientSnapshot(socket, clientId)
        }

        // Handle ping messages
        if (data.type === 'ping') {
          lastPing = Date.now()
          debug(`💓 Ping from ${clientId}`)
          // Optional: Send pong response
          socket.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }))
          return
        }

        await sendClientSnapshot(socket, clientId)

      } catch (err) {
        error("❌ WS message error:", err && err.message ? err.message : err)
      }
    })

    socket.on("close", (code, reason) => {
      info(`🔌 WebSocket closed for ${clientId || 'unknown'}`)
      debug(`   Close code: ${code}`)
      debug(`   Close reason: ${reason || 'none'}`)
      debug(`   Was registered: ${registered}`)
      debug(`   Last ping: ${Date.now() - lastPing}ms ago`)
    })

    socket.on("error", (err) => {
      error(`❌ WebSocket error for ${clientId || 'unknown'}:`, err.message)
    })
    
    info("🔌 New WebSocket connection established")
  })
}
