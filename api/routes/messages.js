const redis = require("../redis")

module.exports = async function (fastify) {
  fastify.post("/messages/send", async (req, res) => {
    const { clientId, phoneNumber, text, files = [] } = req.body

    if (!clientId || !phoneNumber) {
      return res.code(400).send({ error: "Missing fields" })
    }

    if (!text && !files.length) {
      return res.code(400).send({ error: "Nothing to send" })
    }

    await redis.lpush(
      `wa:pending:${clientId}`,
      JSON.stringify({
        type: "SEND_MESSAGE",
        clientId,
        phoneNumber,
        text,
        files
      })
    )

    return { ok: true, queued: true }
  })
}
