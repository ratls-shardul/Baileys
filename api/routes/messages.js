const redis = require("../redis")

const STATE_KEY = "wa:clients:state"

module.exports = async function (fastify) {

  fastify.post("/messages/send", async (req, res) => {
    const { clientId, phoneNumber, msg, files = [] } = req.body

    if (!clientId || !phoneNumber || !msg) {
      return res.code(400).send({ error: "Missing fields" })
    }

    const state = await redis.hget(STATE_KEY, clientId)

    const payload = {
      type: "SEND_MESSAGE",
      clientId,
      phoneNumber,
      msg,
      files
    }

    if (state === "CONNECTED") {
      await redis.lpush("wa:commands", JSON.stringify(payload))

      return { ok: true, queued: false }
    }

    await redis.lpush(
      `wa:pending:${clientId}`,
      JSON.stringify(payload)
    )

    return {
      ok: true,
      queued: true,
      state
    }
  })
}
