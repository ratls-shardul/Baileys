async function sendMessageWithMedia(sock, jid, payload) {
  const { text, files = [] } = payload

  // TEXT ONLY
  if (!files.length) {
    if (!text) return
    const res = await sock.sendMessage(jid, { text })
    console.log("response from sendMessage", res)
    return
  }

  // SINGLE files
  if (files.length === 1) {
    const m = files[0]

    const canCaption = canUseCaption(m.mimeType)
    const message = buildMediaMessage(m, canCaption ? text : undefined)
    const res = await sock.sendMessage(jid, message)
    console.log("response from sendMessage single media", res)

    if (text && !canCaption) {
      const resText = await sock.sendMessage(jid, { text })
      console.log("response from sendMessage text after media", resText)
    }
    return
  }

  // MULTIPLE files
  for (const m of files) {
    const message = buildMediaMessage(m)
    const res = await sock.sendMessage(jid, message)
    console.log("response from sendMessage multiple media", res)
  }

  if (text) {
    const res = await sock.sendMessage(jid, { text })
    console.log("response from sendMessage text only", res)
  }
}

function canUseCaption(mimeType = "") {
  return mimeType.startsWith("image/") || mimeType.startsWith("video/")
}

function buildMediaMessage(file, caption) {
  const { file_url, mimeType : mimetype , filename } = file

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
