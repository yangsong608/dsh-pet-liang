/**
 * dsh-pet-liang — Host 半侧
 * ---------------------------------------------------------------------------
 * 只做三件事：
 *   1. 发静态资源：assets/ 下的立绘、MOSS 四态、全息基座（exact 路由，启动时枚举）；
 *   2. 费用查询：GET /dsh-pet-liang/api/cost?sessionId=&model=&provider=
 *      经 ctx.sessionController.projections 取 tokenUsage，按 CNY/1M 价目折算；
 *   3. 健康检查：GET /dsh-pet-liang/api/health（浏览器半自检用）。
 *
 * 边界：
 *   - 不写任何状态到磁盘；不调用模型；没有 sessionController 时如实报 no-agent-exec。
 *   - 装配失败必须表现为「插件没生效」，绝不阻断 DSH 启动。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'

export const name = 'dsh-pet-liang'
export const inject = ['webServer']

const BASE = '/dsh-pet-liang'
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const ASSET_DIR = join(PLUGIN_DIR, 'assets')

/**
 * 价目：人民币 / 百万 token，分 cacheHit / input(cache miss) / output 三档。
 * 口径对齐 dsh-cost-meter（CNY / 1M tokens）。企业折扣请在客户端设置里覆盖。
 */
const DEFAULT_PRICE = { cacheHit: 0.05, input: 1.5, output: 4.5, label: '默认估价（Flash 档）' }
const PRICES = {
  'deepseek-v4.1-flash': { cacheHit: 0.05, input: 1.5, output: 4.5, label: 'DeepSeek V4.1 Flash' },
  'deepseek-v4-flash': { cacheHit: 0.05, input: 1.5, output: 4.5, label: 'DeepSeek V4 Flash' },
  'deepseek-v4-pro': { cacheHit: 0.15, input: 4.5, output: 13.5, label: 'DeepSeek V4 Pro' },
  'deepseek-v3.2': { cacheHit: 0.15, input: 4.5, output: 13.5, label: 'DeepSeek V3.2' },
  'deepseek-chat': { cacheHit: 0.07, input: 0.27, output: 1.1, label: 'DeepSeek Chat' },
  'deepseek-reasoner': { cacheHit: 0.14, input: 0.55, output: 2.19, label: 'DeepSeek Reasoner' },
}

const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' }

function sendJson(res, code, payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(buf.length),
  })
  res.end(buf)
}

function sendAsset(req, res, path, type) {
  let info
  try {
    info = statSync(path)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('not found')
  }
  const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=86400, immutable',
    ETag: etag,
    'Content-Length': String(info.size),
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=86400, immutable' })
    return res.end()
  }
  res.writeHead(200, headers)
  createReadStream(path).pipe(res)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * usage 多形态归一 → {cacheHit, input, output, total}。
 * 投影口径：uncachedInputTokens + cacheReadTokens + cacheWriteTokens；
 * 保守算法：cacheWrite 计全额输入，只有 cacheRead 记命中。
 */
export function normalizeUsage(source) {
  const s = source && typeof source === 'object' ? source : null
  if (!s) return null
  const d = s.tokenUsage ?? s.usage ?? s
  if (!d || typeof d !== 'object') return null
  let cacheHit = 0
  let input = 0
  let output = 0
  if (d.uncachedInputTokens !== undefined || d.cacheReadTokens !== undefined) {
    cacheHit = num(d.cacheReadTokens)
    input = num(d.uncachedInputTokens) + cacheHit + num(d.cacheWriteTokens)
    output = num(d.outputTokens)
  } else if (d.input_tokens !== undefined || d.prompt_tokens !== undefined) {
    cacheHit = num(d.cache_hit_tokens ?? d.cache_read_tokens ?? d.cache_read_input_tokens)
    input = num(d.input_tokens ?? d.prompt_tokens)
    output = num(d.output_tokens ?? d.completion_tokens)
  } else if (d.inputTokens !== undefined || d.outputTokens !== undefined) {
    cacheHit = num(d.cacheHitTokens ?? d.cache_hit_tokens)
    input = num(d.inputTokens)
    output = num(d.outputTokens)
  } else {
    return null
  }
  if (input === 0 && output === 0 && cacheHit === 0) return null
  return { cacheHit, input, output, total: input + output }
}

/** 按价目折算人民币；命中价只对 cacheHit 部分生效，剩余输入按未命中价。 */
export function priceUsage(usage, model) {
  const key = String(model || '').toLowerCase()
  let price = PRICES[key]
  if (!price) {
    const hit = Object.keys(PRICES).find((id) => key.startsWith(id))
    price = hit ? PRICES[hit] : DEFAULT_PRICE
  }
  const missInput = Math.max(0, usage.input - usage.cacheHit)
  const cny =
    (usage.cacheHit / 1e6) * price.cacheHit +
    (missInput / 1e6) * price.input +
    (usage.output / 1e6) * price.output
  return {
    currency: 'CNY',
    label: price.label,
    unit: 'CNY / 1M tokens',
    price,
    cny,
    parts: {
      cacheHit: (usage.cacheHit / 1e6) * price.cacheHit,
      input: (missInput / 1e6) * price.input,
      output: (usage.output / 1e6) * price.output,
    },
  }
}

/** 北京时间工作日 09:00–12:00 / 14:00–18:00 记为峰时（只提示，不自动改价）。 */
export function peakInfo(now = new Date()) {
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000)
  const day = beijing.getUTCDay()
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  const weekday = day >= 1 && day <= 5
  const inPeak = weekday && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080))
  return { isPeak: inPeak, label: inPeak ? '峰时' : '谷时', timezone: 'Asia/Shanghai' }
}

function applyImpl(ctx) {
  let webServer = null
  try {
    webServer = typeof ctx.get === 'function' ? ctx.get('webServer', false) : undefined
  } catch {
    /* noop */
  }
  if (!webServer) webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.(`[${name}] 当前 profile 没有可用的 webServer，桌宠不会出现。`)
    return
  }

  const disposers = []
  const route = (path, handler, kind) =>
    webServer.register({ kind: kind || 'exact', path, handler })

  const guard = (path, handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: `${name}: ${String((err && err.message) || err)}` })
      } else {
        res.end()
      }
      ctx.logger?.warn?.(`[${name}] ${path} 失败：${String((err && err.message) || err)}`)
    }
  }

  /* ---------- 静态资源：启动时枚举 assets/，逐个 exact 路由 ---------- */
  let files = []
  try {
    files = readdirSync(ASSET_DIR).filter((file) => MIME[file.split('.').pop().toLowerCase()])
  } catch (err) {
    ctx.logger?.warn?.(`[${name}] 读不到 assets/：${String((err && err.message) || err)}`)
  }
  for (const file of files) {
    const type = MIME[file.split('.').pop().toLowerCase()]
    disposers.push(
      route(`${BASE}/assets/${file}`, guard(`${BASE}/assets/${file}`, (req, res) =>
        sendAsset(req, res, join(ASSET_DIR, file), type))),
    )
  }

  /* ---------- 费用：投影 tokenUsage → 价目折算 ---------- */
  disposers.push(
    route(`${BASE}/api/cost`, guard(`${BASE}/api/cost`, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const url = new URL(req.url, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') || ''
      const model = url.searchParams.get('model') || ''
      const provider = url.searchParams.get('provider') || ''

      let sessionController = null
      try {
        sessionController = typeof ctx.get === 'function' ? ctx.get('sessionController', false) : undefined
      } catch {
        /* noop */
      }

      let usage = null
      let source = 'none'
      if (sessionController && sessionId) {
        if (typeof sessionController.projections === 'function') {
          try {
            const result = await sessionController.projections({ sessionId }, AbortSignal.timeout(6000))
            usage = normalizeUsage(result?.values ?? result)
            if (usage) source = 'sessionController.projections'
          } catch (err) {
            source = `projections-error: ${String((err && err.message) || err)}`
          }
        }
        if (!usage && typeof sessionController.list === 'function') {
          try {
            const listed = await sessionController.list()
            const row = (listed?.items || []).find((item) => item.sessionId === sessionId)
            usage = normalizeUsage(row?.projections?.values ?? row)
            if (usage) source = 'sessionController.list'
          } catch (err) {
            source = `list-error: ${String((err && err.message) || err)}`
          }
        }
      } else if (!sessionController) {
        source = 'no-agent-exec'
      } else if (!sessionId) {
        source = 'no-session'
      }

      const peak = peakInfo()
      if (!usage) {
        return sendJson(res, 200, {
          ok: false,
          reason: source,
          sessionId,
          model: model || 'unknown',
          provider: provider || 'unknown',
          peak,
          hint: '会话尚未产生 token 用量，或宿主未暴露 sessionController。',
        })
      }
      const priced = priceUsage(usage, model)
      return sendJson(res, 200, {
        ok: true,
        source,
        sessionId,
        model: model || 'unknown',
        provider: provider || 'unknown',
        tokens: usage,
        cost: priced,
        peak,
        at: new Date().toISOString(),
      })
    })),
  )

  /* ---------- B 站：热门/排行代理 + 图片代理（点击桌宠看片） ---------- */

  const BILI_HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    Accept: 'application/json, text/plain, */*',
  }

  const trimVideo = (item) => ({
    bvid: String(item?.bvid || ''),
    aid: Number(item?.aid || 0),
    title: String(item?.title || ''),
    pic: String(item?.pic || ''),
    duration: Number(item?.duration || 0),
    owner: String(item?.owner?.name || ''),
    views: Number(item?.stat?.view || 0),
    danmaku: Number(item?.stat?.danmaku || 0),
    pubdate: Number(item?.pubdate || 0),
  })

  disposers.push(
    route(`${BASE}/api/bili`, guard(`${BASE}/api/bili`, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const url = new URL(req.url, 'http://localhost')
      const kind = url.searchParams.get('kind') || 'hot'
      const pn = Math.max(1, Math.min(5, Number(url.searchParams.get('pn') || 1)))
      const ps = Math.max(1, Math.min(20, Number(url.searchParams.get('ps') || 12)))
      let target
      if (kind === 'rank') {
        target = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all`
      } else {
        target = `https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=${pn}`
      }
      try {
        const response = await fetch(target, { headers: BILI_HEADERS, signal: AbortSignal.timeout(9000) })
        const payload = await response.json()
        const raw = kind === 'rank' ? payload?.data?.list : payload?.data?.list
        const list = Array.isArray(raw) ? raw.map(trimVideo).filter((item) => item.bvid) : []
        return sendJson(res, 200, { ok: true, kind, list })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: String((err && err.message) || err), list: [] })
      }
    })),
  )

  disposers.push(
    route(`${BASE}/api/bili-img`, guard(`${BASE}/api/bili-img`, async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const target = url.searchParams.get('u') || ''
      /* 只代理 B 站图床，避免变成任意 URL 的 SSRF 通道 */
      if (!/^https?:\/\/[a-z0-9-]+\.(hdslb\.com|biliimg\.com)\//i.test(target)) {
        return sendJson(res, 400, { ok: false, error: 'host not allowed' })
      }
      try {
        const response = await fetch(target, {
          headers: { ...BILI_HEADERS, Accept: 'image/avif,image/webp,image/*,*/*' },
          signal: AbortSignal.timeout(9000),
        })
        const type = response.headers.get('content-type') || 'image/jpeg'
        if (!/^image\//i.test(type)) return sendJson(res, 415, { ok: false, error: 'not an image' })
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > 3 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: 'image too large' })
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'public, max-age=3600',
          'Content-Length': String(buffer.length),
        })
        res.end(buffer)
      } catch (err) {
        sendJson(res, 502, { ok: false, error: String((err && err.message) || err) })
      }
    })),
  )

  disposers.push(
    route(`${BASE}/api/health`, guard(`${BASE}/api/health`, (_req, res) =>
      sendJson(res, 200, { ok: true, name, assets: files.length }))),
  )

  ctx.effect?.(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* noop */
      }
    }
  })
}

export function apply(ctx) {
  try {
    applyImpl(ctx)
  } catch (err) {
    try {
      ctx.logger?.warn?.(`[${name}] 装配失败（已忽略，不影响 DSH 启动）：${String((err && err.message) || err)}`)
    } catch {
      /* noop */
    }
  }
}
