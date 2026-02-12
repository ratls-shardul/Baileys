const { register } = require("../wsHub")
const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.get("/ws", { websocket: true }, (socket) => {

    let registeredClientId = null

    socket.on("message", async (raw) => {
      try {
        const { clientId } = JSON.parse(raw.toString())
        if (!clientId) return

        // 🔒 Prevent double registration on multiple FE messages
        if (!registeredClientId) {
          registeredClientId = clientId
          register(clientId, socket)
        }

        // 🔁 Always send current state
        const state = await redis.hget("wa:clients:state", clientId)

        socket.send(JSON.stringify({
          type: "status",
          clientId,
          state: state || "NON_EXISTENT"
        }))

        // 🔁 Always send stored QR (if exists)
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

    socket.on("close", () => {
      registeredClientId = null
    })
  })
}