const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
}

const LOG_LEVEL = (process.env.API_LOG_LEVEL || process.env.LOG_LEVEL || "info").toLowerCase()

function levelValue(level) {
  return LEVELS[level] ?? LEVELS.info
}

function shouldLog(level) {
  return levelValue(level) <= levelValue(LOG_LEVEL)
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

function log(level, message, meta) {
  if (!shouldLog(level)) return
  const line = formatLine(level, message, meta)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

module.exports = {
  log,
  error: (message, meta) => log("error", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  info: (message, meta) => log("info", message, meta),
  debug: (message, meta) => log("debug", message, meta),
  LOG_LEVEL
}
