const { debug } = require("./logger")

async function sendMessageWithMedia(sock, jid, payload) {
  const { text, files = [] } = payload

  // TEXT ONLY
  if (!files.length) {
    if (!text) return
    const res = await sock.sendMessage(jid, { text })
    debug("response from sendMessage", res && res.key ? res.key : res)
    return
  }

  // SINGLE files
  if (files.length === 1) {
    const m = files[0]

    const canCaption = canUseCaption(m.mimeType)
    const message = buildMediaMessage(m, canCaption ? text : undefined)
    const res = await sock.sendMessage(jid, message)
    debug("response from sendMessage single media", res && res.key ? res.key : res)

    if (text && !canCaption) {
      const resText = await sock.sendMessage(jid, { text })
      debug("response from sendMessage text after media", resText && resText.key ? resText.key : resText)
    }
    return
  }

  // MULTIPLE files
  for (const m of files) {
    const message = buildMediaMessage(m)
    const res = await sock.sendMessage(jid, message)
    debug("response from sendMessage multiple media", res && res.key ? res.key : res)
  }

  if (text) {
    const res = await sock.sendMessage(jid, { text })
    debug("response from sendMessage text only", res && res.key ? res.key : res)
  }
}

function canUseCaption(mimeType = "") {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType === "application/pdf"
  )
}

function buildMediaMessage(file, caption) {
  const { file_url, mimeType, filename } = file || {}
  if (!file_url || typeof file_url !== "string") {
    throw new Error("Invalid media payload: file_url is required")
  }
  const mimetype = typeof mimeType === "string" ? mimeType.toLowerCase() : "application/octet-stream"

  if (mimetype.startsWith("image/")) {
    return {
      image: { url: file_url },
      ...(caption && { caption })
    }
  }

  if (mimetype.startsWith("video/")) {
    return {
      video: { url: file_url },
      ...(caption && { caption })
    }
  }

  if (mimetype.startsWith("audio/")) {
    return {
      audio: { url: file_url },
      mimetype
    }
  }

  return {
    document: { url: file_url },
    mimetype,
    fileName: filename || "file"
  }
}

module.exports = { sendMessageWithMedia }
