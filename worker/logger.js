const fs = require("fs")
const path = require("path")

const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
}

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase()
const CLIENT_LOG_LEVEL = (process.env.CLIENT_LOG_LEVEL || LOG_LEVEL).toLowerCase()
const CLIENT_LOGS_DIR = process.env.LOG_CLIENTS_DIR

let clientLogsReady = false
let clientLogsInitError = null

function levelValue(level) {
  return LEVELS[level] ?? LEVELS.info
}

function shouldLog(level) {
  return levelValue(level) <= levelValue(LOG_LEVEL)
}

function shouldLogClient(level) {
  return levelValue(level) <= levelValue(CLIENT_LOG_LEVEL)
}

function formatLine(level, message, meta) {
  const ts = new Date().toISOString()
  const base = `[${ts}] ${level.toUpperCase()} ${message}`
  if (meta === undefined) return base
  if (typeof meta === "string") return `${base} ${meta}`
  try {
    return `${base} ${JSON.stringify(meta)}`
  } catch {
    return `${base} [meta_unserializable]`
  }
}

function ensureClientLogsDir() {
  if (!CLIENT_LOGS_DIR || clientLogsReady || clientLogsInitError) return
  try {
    fs.mkdirSync(CLIENT_LOGS_DIR, { recursive: true })
    clientLogsReady = true
  } catch (err) {
    clientLogsInitError = err
  }
}

function writeClientLog(clientId, line) {
  if (!CLIENT_LOGS_DIR) return
  ensureClientLogsDir()
  if (!clientLogsReady) return
  const filePath = path.join(CLIENT_LOGS_DIR, `${clientId}.log`)
  fs.promises.appendFile(filePath, line + "\n").catch(() => {})
}

function log(level, message, meta) {
  if (!shouldLog(level)) return
  const line = formatLine(level, message, meta)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

function clientLog(clientId, level, message, meta) {
  if (shouldLogClient(level)) {
    const line = formatLine(level, `[${clientId}] ${message}`, meta)
    writeClientLog(clientId, line)
  }
  log(level, `[${clientId}] ${message}`, meta)
}

module.exports = {
  log,
  clientLog,
  error: (message, meta) => log("error", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  info: (message, meta) => log("info", message, meta),
  debug: (message, meta) => log("debug", message, meta)
}
