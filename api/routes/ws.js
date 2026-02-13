const { register } = require("../wsHub")
const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, (socket, req) => {
    
    let registered = false
    let clientId = null

    socket.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        clientId = data.clientId
        
        if (!clientId) {
          console.warn("⚠️ Received message without clientId")
          return
        }

        if (!registered) {
          register(clientId, socket)
          registered = true
          console.log(`✅ WebSocket registered for ${clientId}`)
        }

        const state = await redis.hget("wa:clients:state", clientId)
        
        socket.send(JSON.stringify({
          type: "status",
          clientId,
          state: state || "NON_EXISTENT"
        }))
        
        console.log(`📤 Sent status: ${state || "NON_EXISTENT"} for ${clientId}`)

        const qr = await redis.get(`wa:qr:${clientId}`)
        if (qr) {
          socket.send(JSON.stringify({
            type: "qr",
            clientId,
            qr
          }))
          console.log(`📤 Sent QR for ${clientId}`)
        }

      } catch (err) {
        console.error("❌ WS message error:", err)
      }
    })

    socket.on("close", (code, reason) => {
      console.log(`🔌 WebSocket closed for ${clientId || 'unknown'}`)
      console.log(`   Close code: ${code}`)
      console.log(`   Close reason: ${reason || 'none'}`)
      console.log(`   Was registered: ${registered}`)
    })

    socket.on("error", (err) => {
      console.error(`❌ WebSocket error for ${clientId || 'unknown'}:`, err.message)
    })
    
    console.log("🔌 New WebSocket connection established")
  })
}