global.crypto = require("crypto").webcrypto

// Optional: scrub noisy Signal/ratchet logs if any dependency logs them.
if (process.env.SCRUB_SIGNAL_LOGS === "true") {
  const SENSITIVE_TOKENS = [
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

  function isSensitiveArg(arg) {
    if (!arg) return false
    if (typeof arg === "string") {
      return SENSITIVE_TOKENS.some((t) => arg.includes(t))
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
const { info, error } = require("./logger")

async function start() {
  info("🚀 WhatsApp worker starting...")

  // Optional preload (can remove later)
  // await initClient("client-1")

//   for (let i = 0; i <= 200; i++) {
//   await initClient(`client-${i}`);
// }

  startCommandListener()

  setInterval(() => {}, 60_000)
}

start().catch(err => {
  error("❌ Worker crashed", err && err.message ? err.message : err)
  process.exit(1)
})
