const redis = require("../redis")

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
}

function isValidFile(file) {
  return (
    file &&
    typeof file === "object" &&
    isNonEmptyString(file.file_url) &&
    isNonEmptyString(file.mimeType)
  )
}

module.exports = async function (fastify) {
  fastify.post("/messages/send", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {}
    const { clientId, phoneNumber, text, files = [] } = body

    if (!isNonEmptyString(clientId) || phoneNumber === undefined || phoneNumber === null) {
      return res.code(400).send({ error: "Missing fields" })
    }

    if (!Array.isArray(files)) {
      return res.code(400).send({ error: "files must be an array" })
    }

    const trimmedText = typeof text === "string" ? text.trim() : ""
    if (files.some((f) => !isValidFile(f))) {
      return res.code(400).send({
        error: "Each file requires non-empty file_url and mimeType"
      })
    }

    if (!trimmedText && !files.length) {
      return res.code(400).send({ error: "Nothing to send" })
    }

    await redis.lpush(
      `wa:pending:${clientId}`,
      JSON.stringify({
        type: "SEND_MESSAGE",
        clientId,
        phoneNumber,
        text: trimmedText,
        files
      })
    )

    return { ok: true, queued: true }
  })
}
