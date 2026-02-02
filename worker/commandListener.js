const Redis = require("ioredis")
const { initClient, startSenderLoop } = require("./socketManager")
const { sendMessageWithMedia } = require("./mediaSender")

const redis = new Redis({
  host: "redis",
  port: 6379
})

async function startCommandListener() {
  console.log("🧠 Redis command listener started")

  while (true) {
    try {
      const res = await redis.brpop("wa:commands", 0)

      const payload = JSON.parse(res[1])
      console.log("📥 Received command:", payload)

      switch (payload.type) {
        case "ADD_CLIENT": {
          console.log(`➕ Adding client ${payload.clientId}`)
          await initClient(payload.clientId)
          break
        }

      case "SEND_MESSAGE": {
        await redis.lpush(
          `wa:pending:${payload.clientId}`,
          JSON.stringify(payload)
        )

        console.log(`📥 Message queued for ${payload.clientId}`)
        startSenderLoop(payload.clientId)
        break
      }

        default:
          console.log("⚠️ Unknown command type:", payload.type)
      }
    } catch (err) {
      console.error("❌ Command processing failed", err)
    }
  }
}

module.exports = { startCommandListener }
