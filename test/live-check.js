/**
 * Talks to the REAL HuggingFace space (not the mock) and prints exactly what
 * happens. Needs unrestricted outbound internet to *.hf.space.
 *
 *   NODE_PATH=/home/user/sandbox-deps/node_modules node test/live-check.js
 */

const crypto = require("node:crypto")
const editimg = require("../lib/editimg.js")
const { makePng } = require("./mock-gradio-server.js")

;(async () => {
  const base = process.env.QWEN_EDIT_BASE || editimg.DEFAULTS.base
  console.log(`space  : ${base}`)

  const dns = require("node:dns").promises
  const { URL } = require("node:url")
  const host = new URL(base).host

  try {
    const addrs = await dns.resolve(host)
    console.log(`dns    : ${host} -> ${addrs.join(", ")}`)
  } catch (e) {
    console.log(`dns    : FAILED (${e.code || e.message})`)
  }

  const t = Date.now()
  try {
    const url = await editimg("make it a studio portrait", makePng(64, 64, [10, 200, 120]), {
      base,
      timeout: 45000,
      idleTimeout: 20000
    })
    console.log(`result : OK -> ${url}`)
  } catch (e) {
    console.log(`result : FAILED after ${Date.now() - t}ms -> ${e.message}`)
    if (e.cause) console.log(`cause  : ${e.cause.message || e.cause.code}`)
  }
})()
