global.crypto = require("crypto").webcrypto

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
