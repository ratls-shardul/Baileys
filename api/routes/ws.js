const { register } = require("../wsHub")
const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, (socket, req) => {

    let registered = false

    socket.on("message", async (raw) => {
      try {
        const { clientId } = JSON.parse(raw.toString())
        if (!clientId) return

        if (!registered) {
          register(clientId, socket)
          registered = true
        }

        const state = await redis.hget("wa:clients:state", clientId)

        socket.send(JSON.stringify({
          type: "status",
          clientId,
          state: state || "NON_EXISTENT"
        }))

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