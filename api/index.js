const { info, error, LOG_LEVEL } = require("./logger")
const fastify = require("fastify")({ logger: { level: LOG_LEVEL } })
const redis = require("./redis")

const start = async () => {
  try {
    await fastify.register(require("@fastify/websocket"))
    await fastify.register(require("@fastify/cors"), {
      origin: true
    })

    fastify.register(require("./routes/ws"))
    fastify.register(require("./routes/clients"))
    fastify.register(require("./routes/messages"))
    fastify.register(require("./routes/debug-routes"))

    const { startConsumer } = require("./streamConsumer")
    startConsumer().catch(err => {
      error("❌ Stream consumer failed to start:", err && err.message ? err.message : err)
      process.exit(1)
    })

    await redis.ping()
    info("✅ Redis connected")

    fastify.get("/health", async () => {
      return { status: "ok" }
    })

    await fastify.listen({ port: 3000, host: "0.0.0.0" })
    info("🚀 API running on port 3000")
  } catch (err) {
    error("❌ API start failed", err && err.message ? err.message : err)
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
