const fs = require("fs")
const path = require("path")
const Redis = require("ioredis")

const { initClient } = require("./socketManager")
const { info, warn, error } = require("./logger")

const STATE_KEY = "wa:clients:state"
const SESSION_ROOT = process.env.WA_SESSIONS_DIR || "/sessions"

const redis = new Redis({
  host: "redis",
  port: 6379
})

function shouldAutoRehydrateState(state) {
  return state !== "STOPPED" && state !== "LOGGED_OUT"
}

function listSessionClientIds(sessionRoot = SESSION_ROOT) {
  try {
    return fs.readdirSync(sessionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(Boolean)
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      warn(`⚠️ Failed to read session directory '${sessionRoot}': ${err.message}`)
    }
    return []
  }
}

async function collectClientsToRehydrate({ redisClient = redis, sessionRoot = SESSION_ROOT } = {}) {
  let states = {}

  try {
    states = await redisClient.hgetall(STATE_KEY)
  } catch (err) {
    warn(`⚠️ Failed to read '${STATE_KEY}' during startup rehydration: ${err.message}`)
  }

  const sessionClientIds = listSessionClientIds(sessionRoot)
  const clientIds = new Set()

  for (const [clientId, state] of Object.entries(states || {})) {
    if (shouldAutoRehydrateState(state)) {
      clientIds.add(clientId)
    }
  }

  for (const clientId of sessionClientIds) {
    if (shouldAutoRehydrateState(states[clientId])) {
      clientIds.add(clientId)
    }
  }

  return [...clientIds].sort((a, b) => a.localeCompare(b))
}

async function rehydrateClients({ redisClient = redis, sessionRoot = SESSION_ROOT } = {}) {
  const clientIds = await collectClientsToRehydrate({ redisClient, sessionRoot })

  if (clientIds.length === 0) {
    info("ℹ️ No clients found for startup rehydration")
    return []
  }

  info(`♻️ Rehydrating ${clientIds.length} client(s) on worker startup`)

  for (const clientId of clientIds) {
    try {
      await initClient(clientId)
    } catch (err) {
      error(`❌ Failed to rehydrate client '${clientId}'`, err && err.message ? err.message : err)
    }
  }

  return clientIds
}

module.exports = {
  rehydrateClients,
  _test: {
    shouldAutoRehydrateState,
    listSessionClientIds,
    collectClientsToRehydrate
  }
}
