const Redis = require("ioredis")
const { clientLog } = require("./logger")

const redis = new Redis({
  host: "redis",
  port: 6379
})

const KEY = "wa:clients:state"

const STATES = {
  CREATED: "CREATED",
  CONNECTING: "CONNECTING",
  QR_REQUIRED: "QR_REQUIRED",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  LOGGED_OUT: "LOGGED_OUT",
  STOPPED: "STOPPED"
}

async function setClientState(clientId, state) {
  await redis.hset(KEY, clientId, state)
  clientLog(clientId, "info", `📊 state → ${state}`)
}

async function removeClientState(clientId) {
  await redis.hdel(KEY, clientId)
}

module.exports = {
  STATES,
  setClientState,
  removeClientState
}
