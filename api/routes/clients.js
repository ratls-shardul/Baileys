const redis = require("../redis")

const STATE_KEY = "wa:clients:state"
const CLIENT_ID_RE = /^[a-zA-Z0-9._:-]{1,120}$/

module.exports = async function (fastify) {

  fastify.get("/clients", async () => {
    return await redis.hgetall(STATE_KEY)
  })

  fastify.post("/clients/:clientId", async (req, res) => {
    const { clientId } = req.params
    if (!CLIENT_ID_RE.test(clientId)) {
      return res.code(400).send({
        error: "Invalid clientId format"
      })
    }

    const existingState = await redis.hget(STATE_KEY, clientId)
    if (existingState) {
      return res.code(409).send({
        error: "Client already exists",
        clientId,
        state: existingState
      })
    }

    await redis.hset(STATE_KEY, clientId, "CREATED")

    await redis.lpush(
      "wa:commands",
      JSON.stringify({ type: "ADD_CLIENT", clientId })
    )

    return { ok: true, clientId }
  })

  fastify.post("/clients/:clientId/reconnect", async (req, res) => {
    const { clientId } = req.params
    const state = await redis.hget(STATE_KEY, clientId)

    if (state !== "LOGGED_OUT" && state !== "DISCONNECTED" && state !== "STOPPED") {
      return res.code(400).send({
        error: "Client must be LOGGED_OUT, DISCONNECTED, or STOPPED"
      })
    }

    await redis.lpush(
      "wa:commands",
      JSON.stringify({ type: "ADD_CLIENT", clientId })
    )

    return { ok: true, clientId }
  })

  fastify.post("/clients/:clientId/restart", async (req, res) => {
    const { clientId } = req.params
    const resetSession = Boolean(req.body && req.body.resetSession)

    await redis.lpush(
      "wa:commands",
      JSON.stringify({ type: "RESTART_CLIENT", clientId, resetSession })
    )

    return { ok: true, clientId, resetSession }
  })

  fastify.post("/clients/:clientId/stop", async (req, res) => {
    const { clientId } = req.params
    const resetSession = Boolean(req.body && req.body.resetSession)

    await redis.lpush(
      "wa:commands",
      JSON.stringify({ type: "STOP_CLIENT", clientId, resetSession })
    )

    return { ok: true, clientId, resetSession }
  })

  fastify.delete("/clients/:clientId", async (req, res) => {
    const { clientId } = req.params

    await redis.lpush(
      "wa:commands",
      JSON.stringify({ type: "DELETE_CLIENT", clientId })
    )

    return { ok: true, clientId }
  })

  fastify.get("/clients/:clientId/status", async (req, res) => {
  const { clientId } = req.params;

  const state = await redis.hget(STATE_KEY, clientId);

  if (!state) {
    return {
      clientId,
      state: "NON_EXISTENT"
    };
  }

  return {
    state
  };
});

}
