const axios = require("axios")

async function sendMessageWithMedia(sock, jid, payload) {
  const { msg, files = [] } = payload

  // CASE 1: Only text
  if (!files.length) {
    await sock.sendMessage(jid, { text: msg })
    return
  }

  // CASE 2: Single media (caption)
  if (files.length === 1) {
    const file = files[0]

    const media = await fetchMedia(file)

    await sock.sendMessage(jid, {
      ...media,
      caption: msg
    })

    return
  }

  // CASE 3: Multiple media
  for (const file of files) {
    const media = await fetchMedia(file)
    await sock.sendMessage(jid, media)
  }

  // Send text separately at the end
  if (msg) {
    await sock.sendMessage(jid, { text: msg })
  }
}

async function fetchMedia(file) {
  const response = await axios.get(file.file_url, {
    responseType: "arraybuffer"
  })

  const buffer = Buffer.from(response.data)

  if (file.mimeType.startsWith("image/")) {
    return { image: buffer }
  }

  if (file.mimeType.startsWith("video/")) {
    return { video: buffer }
  }

  return {
    document: buffer,
    mimetype: file.mimeType,
    fileName: file.filename
  }
}

module.exports = { sendMessageWithMedia }
