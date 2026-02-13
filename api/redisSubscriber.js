const Redis = require("ioredis")
const { broadcast } = require("./wsHub")

function createSubscriber() {
  const sub = new Redis({
    host: process.env.REDIS_HOST || "redis",
    port: 6379,
    retryStrategy(times) {
      const delay = Math.min(times * 100, 2000)
      console.log(`🔁 Redis subscriber retry #${times}, delay ${delay}ms`)
      return delay
    }
  })

  sub.on("connect", () => {
    console.log("🟢 Redis WS subscriber connected")
  })

  sub.on("ready", async () => {
    console.log("📡 Subscribing to wa:events")
    await sub.subscribe("wa:events")
  })

  sub.on("message", (_, raw) => {
    try {
      const event = JSON.parse(raw)
      console.log("REDIS EVENT:", event)
      broadcast(event.clientId, event)
    } catch (err) {
      console.error("Invalid Redis event", err)
    }
  })

  sub.on("error", (err) => {
    console.error("❌ Redis subscriber error:", err.message)
  })

  sub.on("close", () => {
    console.warn("⚠️ Redis subscriber connection closed")
  })

  return sub
}

createSubscriber()