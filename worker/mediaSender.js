const axios = require("axios")

async function sendMessageWithMedia(sock, jid, payload) {
  const { text, files = [] } = payload

  // TEXT ONLY
  if (!files.length) {
    if (!text) return
    await sock.sendMessage(jid, { text })
    return
  }

  // SINGLE files
  if (files.length === 1) {
    const m = files[0]

    const message = buildMediaMessage(m, text)
    await sock.sendMessage(jid, message)
    return
  }

  // MULTIPLE files
  for (const m of files) {
    const message = buildMediaMessage(m)
    await sock.sendMessage(jid, message)
  }

  if (text) {
    await sock.sendMessage(jid, { text })
  }
}

function buildMediaMessage(files, caption) {
  const { file_url, mimetype, filename } = files

  if (mimetype.startsWith("image/")) {
    return {
      image: { file_url },
      caption
    }
  }

  if (mimetype.startsWith("video/")) {
    return {
      video: { file_url },
      caption
    }
  }

  if (mimetype.startsWith("audio/")) {
    return {
      audio: { file_url },
      mimetype
    }
  }

  // documents (pdf, docx, etc)
  return {
    document: { file_url },
    mimetype,
    fileName: filename || "file"
  }
}

module.exports = { sendMessageWithMedia }