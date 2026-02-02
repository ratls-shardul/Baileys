global.crypto = require("crypto").webcrypto

const { initClient } = require("./socketManager")
const { startCommandListener } = require("./commandListener")

async function start() {
  console.log("🚀 WhatsApp worker starting...")

  // Optional preload (can remove later)
  // await initClient("client-1")

//   for (let i = 0; i <= 200; i++) {
//   await initClient(`client-${i}`);
// }

  startCommandListener()

  setInterval(() => {}, 60_000)
}

start().catch(err => {
  console.error("❌ Worker crashed", err)
  process.exit(1)
})
