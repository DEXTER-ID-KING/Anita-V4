/**
 * Local test for lib/editimg.js - runs against the fake Gradio space
 * (test/mock-gradio-server.js), so nothing leaves the machine.
 *
 *   NODE_PATH=/home/user/sandbox-deps/node_modules node test/test-editimg.js
 */

const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const axios = require("axios")

const editimg = require("../lib/editimg.js")
const { startMockGradio, makePng } = require("./mock-gradio-server.js")

const PORT = Number(process.env.MOCK_PORT || 8787)
let pass = 0
let fail = 0

const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}${extra ? " - " + extra : ""}`)
  } else {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? " - " + extra : ""}`)
  }
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")

async function expectThrow(name, fn, match) {
  try {
    await fn()
    ok(name, false, "no error thrown")
  } catch (e) {
    ok(name, !match || match.test(e.message), e.message)
  }
}

;(async () => {
  const mock = await startMockGradio({ port: PORT })
  const base = mock.base
  console.log(`mock Gradio space listening on ${base}\n`)

  const png = makePng(96, 96, [30, 120, 200])
  const tmpFile = path.join(os.tmpdir(), `editimg-input-${Date.now()}.png`)
  fs.writeFileSync(tmpFile, png)

  const opts = { base, timeout: 20000, idleTimeout: 5000 }

  // ---------------------------------------------------------------- 1. Buffer
  console.log("1) Buffer input")
  const url1 = await editimg("make it a studio portrait", png, opts)
  ok("returns a URL", /^https?:\/\//.test(url1 || ""), String(url1))

  const img = await axios.get(url1, { responseType: "arraybuffer" })
  ok("URL serves real image bytes", img.data.length > 0 && sha(Buffer.from(img.data)).length === 64,
    `${img.data.length} bytes, content-type=${img.headers["content-type"]}`)

  const up = mock.state.uploads.at(-1)
  ok("uploaded bytes match the input", up && up.sha256 === sha(png), `${up?.bytes} bytes, sha=${up?.sha256?.slice(0, 12)}`)
  ok("multipart field is `files` with image content-type", /filename=/.test(up?.filename ? "filename=" : "") && /image/.test(up.contentType || ""), up?.contentType)

  const join = mock.state.joins.at(-1)
  ok("fn_index is 0", join?.fn_index === 0)
  ok("payload has 9 items (images, prompt, 7 params)", Array.isArray(join?.data) && join.data.length === 9,
    `len=${join?.data?.length}`)
  ok("prompt is in slot 2", join?.data?.[1] === "make it a studio portrait")
  ok("image is gradio.FileData", join?.data?.[0]?.[0]?.image?.meta?._type === "gradio.FileData")
  ok("session_hash present", typeof join?.session_hash === "string" && join.session_hash.length === 12)

  // ------------------------------------------------------------- 2. file path
  console.log("\n2) Local file path input")
  const url2 = await editimg("turn the sky purple", tmpFile, opts)
  ok("returns a URL", /^https?:\/\//.test(url2 || ""))
  ok("uploaded the file contents", mock.state.uploads.at(-1).sha256 === sha(png))

  // -------------------------------------------------------------- 3. data URI
  console.log("\n3) data URI input")
  const url3 = await editimg("add neon lights", `data:image/png;base64,${png.toString("base64")}`, opts)
  ok("returns a URL", /^https?:\/\//.test(url3 || ""))
  ok("uploaded the decoded bytes", mock.state.uploads.at(-1).sha256 === sha(png))

  // ---------------------------------------------------------------- 4. http URL
  console.log("\n4) Remote http URL input")
  const url4 = await editimg("make it night", `${base}/test-input.png`, opts)
  ok("returns a URL", /^https?:\/\//.test(url4 || ""))
  ok("downloaded + re-uploaded the image", mock.state.uploads.at(-1).sha256 === sha(makePng(96, 96, [30, 120, 200])))

  // ------------------------------------------------------------- 5. progress cb
  console.log("\n5) onProgress callback")
  const progress = []
  await editimg("progress test", png, { ...opts, onProgress: (p) => progress.push(p) })
  ok("onProgress fired", progress.length >= 1, `${progress.length} update(s)`)

  // ---------------------------------------------------------------- 6. errors
  console.log("\n6) Error handling")
  await expectThrow("empty prompt rejected", () => editimg("", png, opts), /prompt/)
  await expectThrow("missing prompt rejected", () => editimg(undefined, png, opts), /prompt/)
  await expectThrow("non-existent path rejected", () => editimg("x", "/tmp/definitely-not-here.png", opts), /invalid image source/)
  await expectThrow("garbage input rejected", () => editimg("x", 12345, opts), /invalid image source/)
  await expectThrow("empty buffer rejected", () => editimg("x", Buffer.alloc(0), opts), /invalid image source/)

  mock.state.mode = "queue_full"
  await expectThrow("queue_full surfaces an error", () => editimg("x", png, opts), /queue is full/)
  mock.state.mode = "error"
  await expectThrow("server error surfaces an error", () => editimg("x", png, opts), /CUDA out of memory/)
  mock.state.mode = "silent"
  await expectThrow("stream ending early throws", () => editimg("x", png, opts), /stream ended/)

  mock.state.mode = "ok"
  await expectThrow("dead space throws a clean upload error",
    () => editimg("x", png, { ...opts, base: "http://127.0.0.1:1" }), /upload failed/)

  // ------------------------------------------------------------- 7. slow space
  console.log("\n7) Slow space (multi-chunk SSE)")
  mock.state.mode = "slow"
  const url7 = await editimg("slow but works", png, opts)
  ok("still returns the URL after delayed events", /^https?:\/\//.test(url7 || ""))
  mock.state.mode = "ok"

  await mock.close()
  fs.rmSync(tmpFile, { force: true })

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error(`\nTest crashed: ${e.message}`)
  process.exit(1)
})
