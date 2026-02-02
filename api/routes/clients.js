const redis = require("../redis")

const STATE_KEY = "wa:clients:state"

module.exports = async function (fastify) {

  // 🔍 List all clients + states
  fastify.get("/clients", async () => {
    return await redis.hgetall(STATE_KEY)
  })

  // ➕ Create / init client (QR flow)
  fastify.post("/clients/:clientId", async (req, res) => {
    const { clientId } = req.params

    await redis.hset(STATE_KEY, clientId, "CREATED")

    await redis.lpush(
      "wa:commands",
      JSON.stringify({ type: "ADD_CLIENT", clientId })
    )

    return { ok: true, clientId }
  })

  // 🔄 Reconnect after logout
  fastify.post("/clients/:clientId/reconnect", async (req, res) => {
    const { clientId } = req.params
    const state = await redis.hget(STATE_KEY, clientId)

    if (state !== "LOGGED_OUT") {
      return res.code(400).send({
        error: "Client is not logged out"
      })
    }

    await redis.lpush(
      "wa:commands",
      JSON.stringify({ type: "ADD_CLIENT", clientId })
    )

    return { ok: true, clientId }
  })

  fastify.get("/clients/:clientId/status", async (req, res) => {
  const { clientId } = req.params;

  const state = await redis.hget(STATE_KEY, clientId);

  // ✅ Client has never been created
  if (!state) {
    return {
      clientId,
      state: "NON_EXISTENT"
    };
  }

  return {
    clientId,
    state
  };
});

}
