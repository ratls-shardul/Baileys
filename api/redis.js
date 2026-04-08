const Redis = require("ioredis")
const { error } = require("./logger")

const redis = new Redis({
  host: "redis",
  port: 6379,
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 100, 2000)
  }
})

redis.on("error", (err) => {
  error("❌ Redis error:", err.message)
})

module.exports = redis
