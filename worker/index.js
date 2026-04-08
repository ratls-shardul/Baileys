global.crypto = require("crypto").webcrypto

// Optional: scrub noisy Signal/ratchet logs if any dependency logs them.
if (process.env.SCRUB_SIGNAL_LOGS === "true") {
  const SENSITIVE_TOKENS = [
    "Closing session:",
    "SessionEntry",
    "closing session",
    "signal session",
    "libsignal",
    "chainKey",
    "currentRatchet",
    "ephemeralKeyPair",
    "registrationId",
    "rootKey",
    "baseKey",
    "remoteIdentityKey",
    "messageKeys"
  ]

  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error

  function hasSensitiveShape(value, seen = new Set()) {
    if (!value || typeof value !== "object") return false
    if (seen.has(value)) return false
    seen.add(value)

    if (
      Object.prototype.hasOwnProperty.call(value, "_chains") ||
      Object.prototype.hasOwnProperty.call(value, "currentRatchet") ||
      Object.prototype.hasOwnProperty.call(value, "pendingPreKey") ||
      Object.prototype.hasOwnProperty.call(value, "registrationId")
    ) {
      return true
    }

    for (const nested of Object.values(value)) {
      if (hasSensitiveShape(nested, seen)) return true
    }

    return false
  }

  function isSensitiveArg(arg) {
    if (!arg) return false
    if (typeof arg === "string") {
      return SENSITIVE_TOKENS.some((t) => arg.includes(t))
    }
    if (hasSensitiveShape(arg)) {
      return true
    }
    try {
      const str = JSON.stringify(arg)
      return SENSITIVE_TOKENS.some((t) => str.includes(t))
    } catch {
      return false
    }
  }

  function shouldDrop(args) {
    return args.some(isSensitiveArg)
  }

  console.log = (...args) => {
    if (!shouldDrop(args)) origLog(...args)
  }
  console.warn = (...args) => {
    if (!shouldDrop(args)) origWarn(...args)
  }
  console.error = (...args) => {
    if (!shouldDrop(args)) origError(...args)
  }
}

const { startCommandListener } = require("./commandListener")
const { rehydrateClients } = require("./startupRehydrate")
const { info, error } = require("./logger")

async function start() {
  info("🚀 WhatsApp worker starting...")

  await rehydrateClients()

  startCommandListener()

  setInterval(() => {}, 60_000)
}

start().catch(err => {
  error("❌ Worker crashed", err && err.message ? err.message : err)
  process.exit(1)
})
