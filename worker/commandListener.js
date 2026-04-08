const Redis = require("ioredis")
const { initClient, restartClient, stopClient, deleteClient } = require("./socketManager")
const { info, warn, error } = require("./logger")

const redis = new Redis({
  host: "redis",
  port: 6379
})

async function startCommandListener() {
  info("🧠 Redis command listener started")

  while (true) {
    try {
      const res = await redis.brpop("wa:commands", 0)

      const payload = JSON.parse(res[1])

      switch (payload.type) {
        case "ADD_CLIENT": {
          await initClient(payload.clientId)
          break
        }

        case "RESTART_CLIENT": {
          const resetSession = Boolean(payload.resetSession)
          await restartClient(payload.clientId, { resetSession })
          break
        }

        case "STOP_CLIENT": {
          const resetSession = Boolean(payload.resetSession)
          await stopClient(payload.clientId, { resetSession })
          break
        }

        case "DELETE_CLIENT": {
          await deleteClient(payload.clientId)
          break
        }

        default:
          warn("⚠️ Unknown command type:", payload.type)
      }
    } catch (err) {
      error("❌ Command processing failed", err && err.message ? err.message : err)
    }
  }
}

module.exports = { startCommandListener }
