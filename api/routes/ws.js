const { register } = require("../wsHub")
const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, (socket) => {
    socket.on("message", async (raw) => {
      try {
        const { clientId } = JSON.parse(raw.toString())
        if (!clientId) return

        register(clientId, socket)

        // 🔁 1. Send current state immediately
        const state = await redis.hget("wa:clients:state", clientId)

        socket.send(JSON.stringify({
          type: "status",
          clientId,
          state: state || "NON_EXISTENT"
        }))

        // 🔁 2. Send last QR if exists
        const qr = await redis.get(`wa:qr:${clientId}`)
        if (qr) {
          socket.send(JSON.stringify({
            type: "qr",
            clientId,
            qr
          }))
        }

      } catch (err) {
        console.error("WS init error", err)
      }
    })
  })
}
