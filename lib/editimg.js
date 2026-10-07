/**
 * editimg(prompt, input)  ->  Promise<string>  (URL of the edited image)
 *
 * Qwen-Image-Edit (2509) via a Gradio space.
 *
 *   prompt : text instruction, e.g. "make it look like a studio portrait"
 *   input  : Buffer | data URI ("data:image/png;base64,...") | https URL | local file path
 *
 * Local test mode (see test/mock-gradio-server.js):
 *   QWEN_EDIT_BASE=http://127.0.0.1:8787   node test/test-editimg.js
 *
 * ---------------------------------------------------------------------------
 * NOTE (checked 2026-10-07): the default space,
 *   https://luca115-qwen-image-edit-2509-turbo-lightning.hf.space
 * returns 404 - it has been deleted or made private, so no payload will work
 * against it. Point QWEN_EDIT_BASE at a space that actually exists, e.g. one
 * of the Qwen-Image-Edit spaces listed at
 *   https://huggingface.co/api/spaces?search=qwen-image-edit&sort=likes
 *
 * Different spaces expose different signatures. Example (Graduo 6 `Server`
 * style, NOT the fn_index style used here):
 *   prithivmlmods-qwen-image-edit-2509-loras-fast.hf.space
 *   POST /gradio_api/call/edit_image
 *   data: [image_b64, prompt, lora_adapter, seed, randomize_seed, guidance, steps]
 *   returns: {"image": "data:image/png;base64,...", "seed": 123}
 * Set QWEN_EDIT_BASE + QWEN_EDIT_FN_INDEX / options.payload to match yours.
 */

const crypto = require("node:crypto")
const fs = require("node:fs")
const FormData = require("form-data")

// undici is optional: Node >= 18 already ships fetch/ReadableStream.
let undiciFetch = null
try {
  ({ fetch: undiciFetch } = require("undici"))
} catch {
  undiciFetch = null
}
const httpFetch = undiciFetch || globalThis.fetch
if (typeof httpFetch !== "function") {
  throw new Error("No fetch available: install undici or run on Node >= 18")
}

let axios
try {
  axios = require("axios")
} catch {
  throw new Error("axios is required: npm i axios form-data")
}

const DEFAULT_BASE =
  "https://luca115-qwen-image-edit-2509-turbo-lightning.hf.space"

const DEFAULTS = {
  base: process.env.QWEN_EDIT_BASE || DEFAULT_BASE,
  fnIndex: Number(process.env.QWEN_EDIT_FN_INDEX ?? 0),
  // seed, randomize, num steps, guidance, width, height, negative-prompt-flag
  payload: [0, true, 3, 8, 1024, 1024, false],
  timeout: Number(process.env.QWEN_EDIT_TIMEOUT ?? 180000), // total
  idleTimeout: Number(process.env.QWEN_EDIT_IDLE_TIMEOUT ?? 60000) // no bytes for this long
}

async function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input

  if (typeof input === "string") {
    if (/^data:.*?;base64,/i.test(input)) {
      return Buffer.from(input.split(",")[1] || "", "base64")
    }
    if (/^https?:\/\//i.test(input)) {
      const res = await axios.get(input, { responseType: "arraybuffer", timeout: 60000 })
      return Buffer.from(res.data)
    }
    if (fs.existsSync(input)) return fs.readFileSync(input)
  }
  return null
}

/** Pull the image URL out of a Gradio `output.data` array (or a raw payload). */
function extractUrl(payload) {
  const data = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [payload]

  for (const item of data) {
    if (!item) continue
    if (typeof item === "string") {
      if (/^https?:\/\//i.test(item) || /^data:image\//i.test(item)) return item
      continue
    }
    if (typeof item !== "object") continue
    for (const key of ["url", "image", "path", "name"]) {
      const val = item[key]
      if (typeof val === "string") {
        if (/^https?:\/\//i.test(val) || /^data:image\//i.test(val)) return val
        if (key === "path" && val.startsWith("/")) {
          // relative Gradio file path -> build the absolute URL later
          return { _path: val }
        }
      } else if (val && typeof val === "object") {
        const nested = extractUrl({ data: [val] })
        if (nested) return nested
      }
    }
  }
  return null
}

/** Split a raw SSE byte stream into `data:` payload objects. */
function parseSse(chunk, buffer) {
  buffer.push(chunk)
  const events = []
  const raw = Buffer.concat(buffer).toString("utf8")
  buffer.length = 0

  const parts = raw.split("\n\n")
  for (let i = 0; i < parts.length; i++) {
    // last part may be a partial event -> keep it in the buffer
    if (i === parts.length - 1 && !raw.endsWith("\n\n")) {
      buffer.push(Buffer.from(parts[i], "utf8"))
      break
    }
    const block = parts[i]
    if (!block.trim()) continue
    for (const line of block.split("\n")) {
      const s = line.trim()
      if (!s.startsWith("data:")) continue
      const body = s.slice(5).trim()
      if (!body || body === "[DONE]") continue
      try {
        events.push(JSON.parse(body))
      } catch {
        /* keep-alive comment / partial json -> ignore */
      }
    }
  }
  return events
}

async function editimg(prompt, input, options = {}) {
  const cfg = { ...DEFAULTS, ...options }

  if (!prompt || typeof prompt !== "string") {
    throw new TypeError("editimg: `prompt` must be a non-empty string")
  }

  const buffer = await toBuffer(input)
  if (!buffer || !buffer.length) {
    throw new Error(
      "editimg: invalid image source (expected Buffer, data URI, http(s) URL or existing file path)"
    )
  }

  const base = String(cfg.base).replace(/\/+$/, "")
  const session = crypto.randomBytes(6).toString("hex")

  // 1) upload the file to the Gradio space
  const form = new FormData()
  form.append("files", buffer, {
    filename: `${crypto.randomBytes(16).toString("hex")}.jpg`,
    contentType: "image/jpeg"
  })

  let path
  try {
    const uploadRes = await axios.post(`${base}/gradio_api/upload`, form, {
      headers: { ...form.getHeaders() },
      timeout: 60000
    })
    path = uploadRes.data?.[0]
  } catch (e) {
    throw new Error(
      `editimg: upload failed (${e.response?.status ?? e.code ?? e.message}) - the space may be sleeping or gone`
    )
  }
  if (!path) throw new Error("editimg: upload returned no file path")

  // 2) enqueue the job
  const image = { image: { path, meta: { _type: "gradio.FileData" } } }
  const data = [[image], prompt, ...cfg.payload]

  const joinRes = await httpFetch(`${base}/gradio_api/queue/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gradio-user": "api" },
    body: JSON.stringify({
      data,
      event_data: null,
      fn_index: cfg.fnIndex,
      trigger_id: null,
      session_hash: session
    })
  })

  if (!joinRes.ok) {
    const text = await joinRes.text().catch(() => "")
    throw new Error(
      `editimg: queue/join failed (HTTP ${joinRes.status}) ${text.slice(0, 200)}`
    )
  }

  // 3) read the SSE stream until the job completes
  const controller = new AbortController()
  const kill = setTimeout(() => controller.abort(), cfg.timeout)
  let idle = setTimeout(() => controller.abort(), cfg.idleTimeout)

  try {
    const sse = await httpFetch(`${base}/gradio_api/queue/data?session_hash=${session}`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    })
    if (!sse.ok || !sse.body) {
      throw new Error(`editimg: queue/data failed (HTTP ${sse.status})`)
    }

    const reader = sse.body.getReader()
    const sseBuffer = [] // survives across chunks: an event can be split in two
    let lastUrl = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      clearTimeout(idle)
      idle = setTimeout(() => controller.abort(), cfg.idleTimeout)

      for (const ev of parseSse(Buffer.from(value), sseBuffer)) {
        const msg = ev.msg

        if (msg === "queue_full") throw new Error("editimg: the space queue is full, try again later")
        if (msg === "unexpected_error" || ev.success === false) {
          throw new Error(`editimg: generation failed - ${ev.message || JSON.stringify(ev).slice(0, 200)}`)
        }
        if (msg === "process_generating" || msg === "process_completed") {
          const url = extractUrl(ev.output)
          if (url && typeof url === "string") lastUrl = url
          if (ev.output?.progress_data && typeof cfg.onProgress === "function") {
            cfg.onProgress(ev.output.progress_data)
          }
        }
        if (msg === "process_completed") {
          if (!lastUrl && typeof extractUrl(ev.output) === "object") {
            const rel = extractUrl(ev.output)
            lastUrl = `${base}/gradio_api/file=${rel._path}`
          }
          return lastUrl
        }
      }
    }

    if (lastUrl) return lastUrl
    throw new Error("editimg: stream ended before the job completed")
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("editimg: timed out waiting for the space")
    throw e
  } finally {
    clearTimeout(kill)
    clearTimeout(idle)
  }
}

module.exports = editimg
module.exports.editimg = editimg
module.exports.DEFAULTS = DEFAULTS
