const Redis = require("ioredis")

const redis = new Redis({
  host: "redis",
  port: 6379,
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 2000)
    console.log(`🔁 Redis retry #${times}, delay ${delay}ms`)
    return delay
  }
})

redis.on("connect", () => {
  console.log("✅ Redis connected")
})

redis.on("ready", () => {
  console.log("🚀 Redis ready")
})

redis.on("error", (err) => {
  console.error("❌ Redis error:", err.message)
})

redis.on("close", () => {
  console.warn("⚠️ Redis connection closed")
})

module.exports = redis