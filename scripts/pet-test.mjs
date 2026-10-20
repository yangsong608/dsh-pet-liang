/**
 * dsh-pet-liang 自测（不需要浏览器、不需要 DSH 运行时）
 *
 *   1. 宿主半：用假 ctx 装配，调用 /api/cost，核对 token 归一与人民币折算；
 *   2. 浏览器半：在假 window / 假 react 下加载客户端模块，校验状态决议与四档映射。
 *
 * 跑法：node scripts/pet-test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as host from '../lib/index.js'

let passed = 0
let failed = 0

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log('PASS ' + name + (detail ? '  (' + detail + ')' : ''))
  } else {
    failed += 1
    console.log('FAIL ' + name + (detail ? '  (' + detail + ')' : ''))
  }
}

/* ───────────────────────── 宿主半 ───────────────────────── */

const routes = new Map()
const disposers = []
let controller = null

const fakeCtx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(options) {
          routes.set(options.path, options.handler)
          return () => {}
        },
      }
    }
    if (name === 'sessionController') return controller
    return undefined
  },
  effect(fn) {
    disposers.push(fn())
  },
  logger: { warn() {}, info() {}, debug() {} },
}

host.apply(fakeCtx)

check('宿主半注册了费用路由', routes.has('/dsh-pet-liang/api/cost'))
check('宿主半注册了健康检查', routes.has('/dsh-pet-liang/api/health'))
check(
  '宿主半注册了立绘与基座资源',
  routes.has('/dsh-pet-liang/assets/liang-1.webp') && routes.has('/dsh-pet-liang/assets/holo-pedestal.webp'),
  routes.size + ' 条路由',
)

function fakeRes() {
  const res = { code: 0, body: '', headers: {}, headersSent: false }
  res.writeHead = (code) => {
    res.code = code
    res.headersSent = true
    return res
  }
  res.end = (chunk) => {
    if (chunk) res.body += String(chunk)
    return res
  }
  res.json = () => JSON.parse(res.body)
  return res
}

async function callCost(query, usage) {
  controller = usage
    ? { projections: async () => ({ values: { tokenUsage: usage } }) }
    : null
  const res = fakeRes()
  await routes.get('/dsh-pet-liang/api/cost')({ method: 'GET', url: '/dsh-pet-liang/api/cost?' + query, headers: {} }, res)
  return { code: res.code, json: res.json() }
}

const usage = {
  uncachedInputTokens: 120000,
  cacheReadTokens: 800000,
  cacheWriteTokens: 0,
  outputTokens: 40000,
}

const ok = await callCost('sessionId=s1&model=deepseek-v4.1-flash&provider=deepseek-official', usage)
check('费用接口 ok', ok.code === 200 && ok.json.ok === true, 'source=' + ok.json.source)
check('缓存命中 token 归一', ok.json.tokens.cacheHit === 800000, String(ok.json.tokens.cacheHit))
check('输入 token = 未命中 + 命中', ok.json.tokens.input === 920000, String(ok.json.tokens.input))
check('输出 token 归一', ok.json.tokens.output === 40000, String(ok.json.tokens.output))

/* 800k 命中 × 0.05 + 120k 未命中 × 1.5 + 40k 输出 × 4.5 = 0.04 + 0.18 + 0.18 = 0.40 */
check('人民币折算正确', Math.abs(ok.json.cost.cny - 0.4) < 1e-9, '¥' + ok.json.cost.cny.toFixed(4))
check('价目命中 V4.1 Flash', ok.json.cost.label === 'DeepSeek V4.1 Flash', ok.json.cost.label)
check('峰谷标签存在', typeof ok.json.peak.isPeak === 'boolean', ok.json.peak.label)

const noUsage = await callCost('sessionId=s1&model=deepseek-chat', null)
check('没有投影时如实报缺', noUsage.json.ok === false, noUsage.json.reason)

/* 归一的其他形态 */
check(
  'snake_case usage 也能归一',
  JSON.stringify(host.normalizeUsage({ input_tokens: 10, cache_hit_tokens: 4, output_tokens: 6 })) ===
    JSON.stringify({ cacheHit: 4, input: 10, output: 6, total: 16 }),
)
check('全零 usage 视为没有用量', host.normalizeUsage({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }) === null)

const priced = host.priceUsage({ cacheHit: 0, input: 1e6, output: 0 }, 'unknown-model')
check('未知模型回退默认价目', priced.label === '默认估价（Flash 档）' && Math.abs(priced.cny - 1.5) < 1e-9)

/* ───────────────────────── 浏览器半 ───────────────────────── */

const clientSource = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

let clientExports = null
const fakeReact = {
  createElement() {},
  useMemo: (fn) => fn(),
  useEffect() {},
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_sub, read) => read(),
}

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      clientExports = spec.factory((name) => {
        if (name === 'react') return fakeReact
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}

/* eslint-disable-next-line no-new-func */
new Function(clientSource)()
const internals = clientExports && clientExports.__internals

check('客户端模块导出 apply/inject', !!clientExports && typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject))
check('客户端导出可测纯逻辑', !!internals)

function modelState(provider, model, effort, efforts) {
  return {
    current: { provider, model, reasoningEffort: effort },
    groups: [
      {
        id: provider,
        models: [
          {
            id: model,
            label: model,
            reasoning: { efforts: efforts.map((id) => ({ id, name: id })), defaultEffort: efforts[efforts.length - 1] },
          },
        ],
      },
    ],
  }
}

const efforts = ['off', 'low', 'medium', 'high']

const idleLiang = internals.decide({ sessionId: 's1', running: false, modelState: modelState('deepseek-official', 'deepseek-v4.1-flash', 'medium', efforts) })
check('DeepSeek 模型空闲 → 梁神', idleLiang.character === 'liang' && idleLiang.asset.startsWith('liang-'), idleLiang.title + ' / ' + idleLiang.asset)
check('推理档位 medium → tier3', idleLiang.tier === 3, 'tier=' + idleLiang.tier)

const lowEffort = internals.decide({ sessionId: 's1', running: false, modelState: modelState('deepseek-official', 'm', 'off', efforts) })
const highEffort = internals.decide({ sessionId: 's1', running: false, modelState: modelState('deepseek-official', 'm', 'high', efforts) })
check('最低档 → 小梁', lowEffort.tier === 1 && lowEffort.title === '小梁')
check('最高档 → 梁神', highEffort.tier === 4 && highEffort.title === '梁神')

const working = internals.decide({ sessionId: 's1', running: true, modelState: modelState('deepseek-official', 'm', 'high', efforts) })
check('DeepSeek 执行中 → MOSS 工作态', working.character === 'moss' && working.asset === 'moss-work.webp' && working.working === true)

const otherModelIdle = internals.decide({ sessionId: 's1', running: false, modelState: modelState('openai', 'gpt-x', '', []) })
check('非 DeepSeek 空闲 → MOSS 空闲', otherModelIdle.character === 'moss' && otherModelIdle.asset === 'moss-idle.webp' && otherModelIdle.working === false)

const otherModelWorking = internals.decide({ sessionId: 's1', running: true, modelState: modelState('openai', 'gpt-x', '', []) })
check('非 DeepSeek 执行中 → MOSS 工作态', otherModelWorking.character === 'moss' && otherModelWorking.working === true)

const noSession = internals.decide({ sessionId: '', running: false, modelState: null })
check('没有会话时给 MOSS 空闲兜底', noSession.character === 'moss' && noSession.asset === 'moss-idle.webp')

check('单个推理档位落到中间档', internals.tierForSelection({ efforts: [{ id: 'only' }], effort: 'only' }) === 2)

const lines = internals.costLines(ok.json)
check('费用弹层有 3 行明细', lines.ok === true && lines.rows.length === 3, lines.total)
check('金额格式化可用', internals.formatCny(0.4) === '¥0.4000' && internals.formatCny(0) === '¥0')

const emptyLines = internals.costLines({ ok: false, hint: 'x' })
check('缺数据不伪造金额', emptyLines.ok === false && emptyLines.total === '—')

/* ── 投影路径：会话投影 modelSelection（{lastUsed,next}）驱动状态 ── */

const sel = internals.preview.selectionFromProjection({
  lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  next: null,
})
check('投影 lastUsed 能回退取到', !!sel && sel.provider === 'deepseek-official', sel && sel.model)
check('投影 next 优先于 lastUsed', internals.preview.selectionFromProjection({
  lastUsed: { provider: 'openai', model: 'gpt-x' },
  next: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
}).provider === 'deepseek-account')
check('投影缺档位时按 known 档位排序：high → tier4', internals.preview.tierOf({
  provider: 'deepseek-official', model: 'm', effort: 'high', efforts: [], defaultEffort: '',
}) === 4)
check('投影缺档位：medium → tier3', internals.preview.tierOf({
  provider: 'deepseek-official', model: 'm', effort: 'medium', efforts: [], defaultEffort: '',
}) === 3)
check('未知档位名落中间档', internals.preview.tierOf({
  provider: 'deepseek-official', model: 'm', effort: 'weird', efforts: [], defaultEffort: '',
}) === 2)

/* 用假 hooks 把真实的 Bridge 跑一遍：模拟「会话投影里就是 DeepSeek + high」 */
function runBridge({ projection, summaryRunning = false, status }) {
  const effects = []
  const fake = {
    createElement() {},
    useMemo: (fn) => fn(),
    useEffect: (fn) => effects.push(fn),
    useRef: (v) => ({ current: v }),
    useState: (init) => [init, () => {}],
    useSyncExternalStore: (_sub, read) => read(),
  }
  const previous = globalThis.__petReact
  globalThis.__petReact = fake
  const source = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')
  let mod = null
  globalThis.window = {
    __ModuleLoader__: { load: (spec) => { mod = spec.factory(() => fake) } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  /* eslint-disable-next-line no-new-func */
  new Function(source)()
  const api = mod.__internals
  api.preview.bridge({
    ctx: {},
    sessionId: 's1',
    useSessionStatus: (selector) => selector(status),
    useSessions: (selector) => selector({
      ids: ['s1'],
      byId: { s1: { id: 's1', running: summaryRunning, projectionValues: { modelSelection: projection } } },
    }),
    useProjection: (key) => (key === 'modelSelection' ? projection : undefined),
  })
  /* 真实 React 里 effect 会在提交后执行；这里手动跑一遍 */
  for (const effect of effects) effect()
  return api.preview.getState()
}

const deepseekState = runBridge({
  projection: { lastUsed: null, next: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } },
  status: new Map(),
})
check('Bridge：DeepSeek 投影 → 梁神', deepseekState.character === 'liang' && deepseekState.tier === 4, deepseekState.title + ' / ' + deepseekState.asset)

const runningState = runBridge({
  projection: { lastUsed: null, next: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } },
  status: new Map([['s1', { running: true }]]),
})
check('Bridge：执行中 → MOSS 工作态', runningState.character === 'moss' && runningState.working === true)

const summaryOnly = runBridge({
  projection: null,
  summaryRunning: false,
  status: new Map(),
})
check('Bridge：没有投影时不报错（回退 MOSS 空闲）', summaryOnly.character === 'moss')

console.log('\n' + passed + '/' + (passed + failed) + ' 通过')
if (failed > 0) process.exitCode = 1
