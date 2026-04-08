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

    const canCaption = canUseCaption(m.mimeType)
    const message = buildMediaMessage(m, canCaption ? text : undefined)
    await sock.sendMessage(jid, message)

    if (text && !canCaption) {
      await sock.sendMessage(jid, { text })
    }
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

function canUseCaption(mimeType = "") {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/")
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
