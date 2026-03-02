const Redis = require("ioredis")
const { info, warn, error } = require("./logger")

const redis = new Redis({
  host: "redis",
  port: 6379,
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 2000)
    warn(`🔁 Redis retry #${times}, delay ${delay}ms`)
    return delay
  }
})

redis.on("connect", () => {
  info("✅ Redis connected")
})

redis.on("ready", () => {
  info("🚀 Redis ready")
})

redis.on("error", (err) => {
  error("❌ Redis error:", err.message)
})

redis.on("close", () => {
  warn("⚠️ Redis connection closed")
})

module.exports = redis
