const axios = require("axios")

async function sendMessageWithMedia(sock, jid, payload) {
  const { text, media = [] } = payload

  // TEXT ONLY
  if (!media.length) {
    if (!text) return
    await sock.sendMessage(jid, { text })
    return
  }

  // SINGLE MEDIA
  if (media.length === 1) {
    const m = media[0]

    const message = buildMediaMessage(m, text)
    await sock.sendMessage(jid, message)
    return
  }

  // MULTIPLE MEDIA
  for (const m of media) {
    const message = buildMediaMessage(m)
    await sock.sendMessage(jid, message)
  }

  if (text) {
    await sock.sendMessage(jid, { text })
  }
}

function buildMediaMessage(media, caption) {
  const { url, mimetype, filename } = media

  if (mimetype.startsWith("image/")) {
    return {
      image: { url },
      caption
    }
  }

  if (mimetype.startsWith("video/")) {
    return {
      video: { url },
      caption
    }
  }

  if (mimetype.startsWith("audio/")) {
    return {
      audio: { url },
      mimetype
    }
  }

  // documents (pdf, docx, etc)
  return {
    document: { url },
    mimetype,
    fileName: filename || "file"
  }
}

module.exports = { sendMessageWithMedia }