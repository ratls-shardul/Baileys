const { register } = require("../wsHub")
const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, (connection, req) => {
    // Extract the actual WebSocket from Fastify's wrapper
    const socket = connection.socket
    
    let registered = false

    // Handle incoming messages from frontend
    socket.on("message", async (raw) => {
      try {
        const { clientId } = JSON.parse(raw.toString())
        
        if (!clientId) {
          console.warn("⚠️ Received message without clientId")
          return
        }

        // Register socket on first message (for broadcast updates)
        if (!registered) {
          register(clientId, socket)
          registered = true
          console.log(`✅ WebSocket registered for ${clientId}`)
        }

        // Get and send current state
        const state = await redis.hget("wa:clients:state", clientId)
        
        socket.send(JSON.stringify({
          type: "status",
          clientId,
          state: state || "NON_EXISTENT"
        }))
        
        console.log(`📤 Sent status: ${state || "NON_EXISTENT"} for ${clientId}`)

        // Send QR if available
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

    // Handle WebSocket errors
    socket.on("error", (err) => {
      console.error("❌ WebSocket error:", err.message)
    })
  })
}