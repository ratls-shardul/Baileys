const Redis = require("ioredis")
const { broadcast } = require("./wsHub")

const sub = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: 6379
})

sub.subscribe("wa:events")

sub.on("message", (_, raw) => {
  try {
    const event = JSON.parse(raw)
    broadcast(event.clientId, event)
  } catch (err) {
    console.error("Invalid Redis event", err)
  }
})

sub.on("connect", () => {
  console.log("🟢 Redis WS subscriber connected")
})
