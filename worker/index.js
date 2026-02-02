global.crypto = require("crypto").webcrypto

const { initClient } = require("./socketManager")
const { startCommandListener } = require("./commandListener")

async function start() {
  console.log("🚀 WhatsApp worker starting...")

  // Optional preload (can remove later)
  // await initClient("client-1")
  // await initClient("client-2")

  // 🔥 THIS WAS MISSING
  startCommandListener()

  // Keep process alive
  setInterval(() => {}, 60_000)
}

start().catch(err => {
  console.error("❌ Worker crashed", err)
  process.exit(1)
})
