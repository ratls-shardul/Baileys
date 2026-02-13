const fastify = require("fastify")({ logger: true })
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
    fastify.register(require("./routes/debug"))

    require("./redisSubscriber")

    await redis.ping()
    console.log("✅ Redis connected")

    fastify.get("/health", async () => {
      return { status: "ok" }
    })

    await fastify.listen({ port: 3000, host: "0.0.0.0" })
    console.log("🚀 API running on port 3000")
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
