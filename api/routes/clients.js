const redis = require("../redis")

const STATE_KEY = "wa:clients:state"
const SEND_DELAY_CONFIG_KEY = "wa:config:sendDelay"
const CLIENT_ID_RE = /^[a-zA-Z0-9._:-]{1,120}$/
const DEFAULT_SEND_DELAY_MIN_MS = 3000
const DEFAULT_SEND_DELAY_MAX_MS = 8000
const MIN_ALLOWED_SEND_DELAY_MS = 500
const MAX_ALLOWED_SEND_DELAY_MS = 120000

module.exports = async function (fastify) {
  function parseQueueEntry(raw, index) {
    try {
      return { index, raw, parsed: JSON.parse(raw) }
    } catch {
      return { index, raw, parsed: null }
    }
  }

  function normalizeSendDelayConfig(value) {
    const minMs = Number(value && value.minMs)
    const maxMs = Number(value && value.maxMs)

    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
      return null
    }

    const normalizedMin = Math.max(MIN_ALLOWED_SEND_DELAY_MS, Math.floor(minMs))
    const normalizedMax = Math.min(MAX_ALLOWED_SEND_DELAY_MS, Math.floor(maxMs))

    if (normalizedMax < normalizedMin) {
      return null
    }

    return {
      minMs: normalizedMin,
      maxMs: normalizedMax
    }
  }

  async function readSendDelayConfig() {
    try {
      const raw = await redis.get(SEND_DELAY_CONFIG_KEY)
      if (!raw) {
        return {
          minMs: DEFAULT_SEND_DELAY_MIN_MS,
          maxMs: DEFAULT_SEND_DELAY_MAX_MS,
          source: "default"
        }
      }

      const parsed = JSON.parse(raw)
      const normalized = normalizeSendDelayConfig(parsed)
      if (normalized) {
        return {
          ...normalized,
          source: "redis"
        }
      }
    } catch {}

    return {
      minMs: DEFAULT_SEND_DELAY_MIN_MS,
      maxMs: DEFAULT_SEND_DELAY_MAX_MS,
      source: "default"
    }
  }

  fastify.get("/clients", async () => {
    return await redis.hgetall(STATE_KEY)
  })

  fastify.get("/config/send-delay", async () => {
    return await readSendDelayConfig()
  })

  fastify.post("/config/send-delay", async (req, res) => {
    const normalized = normalizeSendDelayConfig(req.body && typeof req.body === "object" ? req.body : null)
    if (!normalized) {
      return res.code(400).send({
        error: `minMs and maxMs are required integers with ${MIN_ALLOWED_SEND_DELAY_MS} <= minMs <= maxMs <= ${MAX_ALLOWED_SEND_DELAY_MS}`
      })
    }

    await redis.set(SEND_DELAY_CONFIG_KEY, JSON.stringify(normalized))

    return {
      ok: true,
      ...normalized
    }
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

  fastify.get("/clients/:clientId/queue", async (req, res) => {
    const { clientId } = req.params
    const requestedLimit = Number(req.query && req.query.limit)
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200)
      : 50
    const queueKey = `wa:pending:${clientId}`
    const total = await redis.llen(queueKey)
    const rows = await redis.lrange(queueKey, 0, limit - 1)
    const messages = rows.map((raw, idx) => parseQueueEntry(raw, idx))
    return {
      clientId,
      total,
      returned: messages.length,
      limit,
      messages
    }
  })

  fastify.delete("/clients/:clientId/queue", async (req, res) => {
    const { clientId } = req.params
    const queueKey = `wa:pending:${clientId}`
    const totalBefore = await redis.llen(queueKey)
    await redis.del(queueKey)
    return {
      ok: true,
      clientId,
      cleared: totalBefore
    }
  })

  fastify.get("/clients/:clientId/status", async (req, res) => {
    const { clientId } = req.params
    const state = await redis.hget(STATE_KEY, clientId)

    if (!state) {
      return {
        clientId,
        state: "NON_EXISTENT"
      }
    }

    return {
      state
    }
  })
}
