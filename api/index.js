const fastify = require("fastify")({ logger: true })
const redis = require("./redis")

fastify.register(require("./routes/clients"))
fastify.register(require("./routes/messages"))

const start = async () => {
  try {
    await redis.ping()
    console.log("✅ Redis connected")

    await fastify.listen({ port: 3000, host: "0.0.0.0" })
    console.log("🚀 API running on port 3000")
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
