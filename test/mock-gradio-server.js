/**
 * Tiny fake Gradio space: replicates the 3 endpoints editimg() talks to.
 *
 *   POST /gradio_api/upload            -> ["<path>"]
 *   POST /gradio_api/queue/join        -> {"event_id": "..."}
 *   GET  /gradio_api/queue/data?...    -> SSE: heartbeat -> generating -> completed
 *   GET  /gradio_api/file=<path>       -> the "edited" image bytes
 *   GET  /test-input.png               -> a sample input image
 *
 * Not a real image model - it just echoes the upload back, so the whole
 * client flow (multipart upload, payload, SSE parsing, URL fetch) is testable
 * without touching the network.
 */

const http = require("node:http")
const crypto = require("node:crypto")
const { URL } = require("node:url")

/** Solid-colour PNG, generated with zlib only (no deps). */
function makePng(width, height, rgb) {
  const zlib = require("node:zlib")
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      const on = (x >> 3) % 2 === (y >> 3) % 2
      raw[o++] = on ? rgb[0] : 255 - rgb[0]
      raw[o++] = on ? rgb[1] : 255 - rgb[1]
      raw[o++] = on ? rgb[2] : 255 - rgb[2]
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

function parseMultipart(body, contentType) {
  const boundary = contentType.split("boundary=")[1]
  if (!boundary) throw new Error("no boundary")
  const delim = Buffer.from(`--${boundary}`)
  const parts = []
  let start = body.indexOf(delim)
  while (start !== -1) {
    const next = body.indexOf(delim, start + delim.length)
    if (next === -1) break
    const part = body.slice(start + delim.length, next)
    const sep = part.indexOf("\r\n\r\n")
    if (sep === -1) break
    const headers = part.slice(0, sep).toString()
    const data = part.slice(sep + 4, part.length - 2) // strip trailing CRLF
    const name = /name="([^"]+)"/.exec(headers)?.[1]
    const filename = /filename="([^"]+)"/.exec(headers)?.[1]
    parts.push({ name, filename, headers, data })
    start = next
  }
  return parts
}

function startMockGradio({ port = 8787, host = "127.0.0.1", mode = "ok" } = {}) {
  const files = new Map() // path -> Buffer
  const state = { uploads: [], joins: [], mode }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`)

    if (req.method === "POST" && url.pathname === "/gradio_api/upload") {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        const body = Buffer.concat(chunks)
        try {
          const parts = parseMultipart(body, req.headers["content-type"] || "")
          const file = parts.find((p) => p.name === "files")
          if (!file) throw new Error("no `files` field in the multipart body")
          if (!file.data.length) throw new Error("uploaded file is empty")

          const path = `/tmp/gradio/${crypto.randomBytes(8).toString("hex")}/${file.filename}`
          files.set(path, file.data)
          state.uploads.push({
            filename: file.filename,
            contentType: /content-type:\s*([^\r\n]+)/i.exec(file.headers)?.[1],
            bytes: file.data.length,
            sha256: crypto.createHash("sha256").update(file.data).digest("hex"),
            path
          })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify([path]))
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/gradio_api/queue/join") {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        let payload = null
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString())
        } catch {}
        state.joins.push(payload)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ event_id: crypto.randomUUID(), success: true }))
      })
      return
    }

    if (req.method === "GET" && url.pathname === "/gradio_api/queue/data") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      })
      const send = (event, obj) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
      const lastUpload = state.uploads[state.uploads.length - 1]
      const outPath = `/tmp/gradio/out-${crypto.randomBytes(6).toString("hex")}.png`
      files.set(outPath, makePng(128, 128, [200, 40, 90]))
      const base = `http://${host}:${port}`

      const steps = []
      if (state.mode === "ok" || state.mode === "slow") {
        steps.push(() => send("heartbeat", { msg: "heartbeat" }))
        steps.push(() => send("estimation", { msg: "estimation", rank: 0, queue_size: 1, rank_eta: 5 }))
        steps.push(() =>
          send("generating", {
            msg: "process_generating",
            success: null,
            output: { data: [], progress_data: [{ index: 0, length: 8, unit: "steps" }] }
          })
        )
        steps.push(() =>
          send("generating", {
            msg: "process_generating",
            success: null,
            output: { data: [], progress_data: [{ index: 8, length: 8, unit: "steps" }] }
          })
        )
        steps.push(() =>
          send("complete", {
            msg: "process_completed",
            success: true,
            output: {
              data: [
                {
                  path: outPath,
                  url: `${base}/gradio_api/file=${outPath}`,
                  orig_name: "output.png",
                  meta: { _type: "gradio.FileData" },
                  source_input: lastUpload?.path
                }
              ]
            }
          })
        )
      } else if (state.mode === "queue_full") {
        steps.push(() => send("queue_full", { msg: "queue_full" }))
      } else if (state.mode === "error") {
        steps.push(() =>
          send("error", { msg: "unexpected_error", success: false, message: "CUDA out of memory" })
        )
      } else if (state.mode === "silent") {
        steps.push(() => send("heartbeat", { msg: "heartbeat" }))
      }

      let i = 0
      const tick = () => {
        if (i >= steps.length) {
          res.end()
          return
        }
        steps[i++]()
        setTimeout(tick, state.mode === "slow" ? 800 : 20)
      }
      tick()
      return
    }

    if (req.method === "GET" && url.pathname.startsWith("/gradio_api/file")) {
      // real Gradio serves output as /gradio_api/file=/tmp/gradio/xxx.png
      const p = decodeURIComponent(url.pathname.replace(/^\/gradio_api\/file=?/, ""))
      const buf = files.get(p)
      if (!buf) {
        res.writeHead(404).end("not found")
        return
      }
      res.writeHead(200, { "content-type": "image/png", "content-length": buf.length })
      res.end(buf)
      return
    }

    if (req.method === "GET" && url.pathname === "/test-input.png") {
      const buf = makePng(96, 96, [30, 120, 200])
      res.writeHead(200, { "content-type": "image/png", "content-length": buf.length })
      res.end(buf)
      return
    }

    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        state,
        base: `http://${host}:${port}`,
        port,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

module.exports = { startMockGradio, makePng }
