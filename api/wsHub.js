const { register, unregister } = require("../wsHub")
const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, (connection, req) => {
    // Extract the actual WebSocket from Fastify's wrapper
    const socket = connection.socket
    
    let clientId = null
    let registered = false

    // Handle incoming messages from frontend
    socket.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        
        if (!data.clientId) {
          socket.send(JSON.stringify({
            type: "error",
            message: "clientId is required"
          }))
          return
        }

        // Register socket on first message
        if (!registered) {
          clientId = data.clientId
          register(clientId, socket)
          registered = true
          console.log(`✅ WebSocket registered for ${clientId}`)
        }

        // Send current state
        const state = await redis.hget("wa:clients:state", data.clientId)
        socket.send(JSON.stringify({
          type: "status",
          clientId: data.clientId,
          state: state || "NON_EXISTENT"
        }))

        // Send QR if available
        const qr = await redis.get(`wa:qr:${data.clientId}`)
        if (qr) {
          socket.send(JSON.stringify({
            type: "qr",
            clientId: data.clientId,
            qr
          }))
        }

      } catch (err) {
        console.error("❌ WS message error:", err)
        socket.send(JSON.stringify({
          type: "error",
          message: err.message
        }))
      }
    })

    // Handle WebSocket close
    socket.on("close", () => {
      if (registered && clientId) {
        console.log(`🔌 WebSocket closed for ${clientId}`)
        unregister(clientId, socket)
      }
    })

    // Handle WebSocket errors
    socket.on("error", (err) => {
      console.error("❌ WebSocket error:", err.message)
    })

    // Send initial connection confirmation
    socket.send(JSON.stringify({
      type: "connected",
      message: "WebSocket connected. Send {clientId: 'your-id'} to register."
    }))
  })
}