/**
 * 桌宠本地预览：不依赖 DSH，起一个静态页把真实的 client.js 挂上去。
 *
 *   node scripts/preview.mjs --port 4311
 *
 * 页面右侧是真实桌宠（同一份 client.js + 同一套 CSS + 同一批素材），
 * 左上角按钮可以切四档梁神 / MOSS 空闲 / MOSS 工作并播放换形动画，
 * 「点击形象」会走真实的 fetch('/dsh-pet-liang/api/cost')（本服务给出样例数据）。
 */

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] ||
  (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 0) || 4311)

const SAMPLE_COST = {
  ok: true,
  source: 'sessionController.projections',
  sessionId: 'preview-session',
  model: 'deepseek-v4.1-flash',
  provider: 'deepseek-official',
  tokens: { cacheHit: 812000, input: 934000, output: 46500, total: 980500 },
  cost: {
    currency: 'CNY',
    label: 'DeepSeek V4.1 Flash',
    cny: 0.2865,
    parts: { cacheHit: 0.0406, input: 0.183, output: 0.2093 },
  },
  peak: { isPeak: false, label: '谷时' },
}


const MOCK_BILI = {
  ok: true,
  kind: 'hot',
  list: [
    { bvid: 'BV1xx411c7mD', title: '【4K修复】流浪地球2 MOSS 全部出场镜头', pic: '/mock-cover.webp', duration: 486, owner: '影视修复组', views: 1284000 },
    { bvid: 'BV1yy411c7mE', title: 'DeepSeek 新模型实测：写代码到底行不行', pic: '/mock-cover.webp', duration: 923, owner: '技术宅小林', views: 486000 },
    { bvid: 'BV1zz411c7mF', title: '一个人做完整产品：从想法到上线', pic: '/mock-cover.webp', duration: 1320, owner: '独立开发者日记', views: 96200 },
    { bvid: 'BV1aa411c7mG', title: '当 AI 变成同事：多智能体协作实测', pic: '/mock-cover.webp', duration: 640, owner: 'Agent 观察', views: 312000 },
  ],
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>dsh-pet-liang · preview</title>
<style>
  html,body{margin:0;height:100%;background:#0b0e13;color:#e6edf6;
    font:14px ui-sans-serif,system-ui,"PingFang SC",sans-serif;overflow:hidden}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;
    background:radial-gradient(900px 520px at 70% 20%,rgba(70,120,180,.14),transparent 70%),
               radial-gradient(600px 400px at 20% 80%,rgba(120,90,40,.10),transparent 70%)}
  .fake-shell{position:relative;display:flex;height:100%}
  .fake-side{width:236px;border-right:1px solid rgba(255,255,255,.06);padding:16px;
    background:rgba(255,255,255,.015)}
  .fake-main{flex:1;padding:22px 26px}
  .fake-h{font-size:15px;font-weight:650;margin:0 0 14px;opacity:.9}
  .fake-line{height:9px;border-radius:5px;background:rgba(255,255,255,.06);margin:9px 0}
  .fake-line.w60{width:60%}.fake-line.w80{width:80%}.fake-line.w40{width:40%}
  .panel{position:fixed;left:24px;top:24px;z-index:10;display:flex;flex-direction:column;gap:10px;
    padding:14px 16px;border-radius:14px;background:rgba(12,16,22,.82);
    border:1px solid rgba(120,200,255,.18);backdrop-filter:blur(12px);width:250px}
  .panel h1{font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.55;margin:0 0 2px}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  button{cursor:pointer;font:inherit;font-size:12px;padding:7px 11px;border-radius:8px;
    color:#dbe6f3;background:rgba(120,180,255,.10);border:1px solid rgba(120,200,255,.22)}
  button:hover{background:rgba(120,180,255,.18)}
  .hint{font-size:11px;line-height:1.6;opacity:.5}
</style></head>
<body>
<div class="fake-shell">
  <div class="fake-side">
    <p class="fake-h">DSH</p>
    <div class="fake-line w80"></div><div class="fake-line w60"></div><div class="fake-line w80"></div>
    <div class="fake-line w40"></div><div class="fake-line w60"></div>
  </div>
  <div class="fake-main">
    <p class="fake-h">这只是预览背景，桌宠是真实插件产出的那一份 DOM</p>
    <div class="fake-line w80"></div><div class="fake-line w60"></div><div class="fake-line w80"></div>
    <div class="fake-line w40"></div>
  </div>
</div>

<div class="panel">
  <h1>状态演示</h1>
  <div class="row">
    <button data-tier="1">小梁</button><button data-tier="2">梁子</button>
    <button data-tier="3">梁圣</button><button data-tier="4">梁神</button>
  </div>
  <div class="row">
    <button data-mode="moss-idle">MOSS 空闲</button>
    <button data-mode="moss-work">MOSS 工作</button>
  </div>
  <div class="row"><button data-mode="toggle-cost">点击形象看费用</button></div>
  <p class="hint">梁神↔MOSS 会播放换形动画；费用弹层走真实接口路径，数据由预览服务给出。</p>
</div>

<script>
  window.__ModuleLoader__ = { load(spec) { window.__petModule = spec.factory((name) => {
    if (name === 'react') return {
      createElement() {}, useMemo: (fn) => fn(), useEffect() {}, useRef: (v) => ({ current: v }),
      useSyncExternalStore: (_s, read) => read(),
    }
    throw new Error('unexpected require ' + name)
  }) } }
</script>
<script src="/client/client.js"></script>
<script>
  const API = window.__petModule.__internals
  const slots = { inject(_key, fn) { try { fn() } catch (e) {} return () => {} },
                  register() { return () => {} } }
  window.__petModule.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  const efforts = ['off', 'low', 'medium', 'high']
  function stateFor(tier) {
    const effort = efforts[tier - 1]
    return {
      sessionId: 'preview-session', running: false,
      modelState: { current: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash', reasoningEffort: effort },
        groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash',
          reasoning: { efforts: efforts.map((id) => ({ id, name: id })), defaultEffort: 'high' } }] }] },
    }
  }
  document.querySelectorAll('[data-tier]').forEach((btn) => {
    btn.onclick = () => API.preview.publish(API.decide(stateFor(Number(btn.dataset.tier))))
  })
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.mode === 'toggle-cost') {
        document.querySelector('.orb').click()
        return
      }
      const running = btn.dataset.mode === 'moss-work'
      API.preview.publish(API.decide({ sessionId: 'preview-session', running,
        modelState: running ? null : { current: { provider: 'openai', model: 'gpt-x' }, groups: [] } }))
    }
  })
  /* 首屏：?tier=1..4 选档，?moss=idle|work 走 MOSS，?cost=1 自动打开费用弹层 */
  const params = new URLSearchParams(location.search)
  const tier = Math.min(4, Math.max(1, Number(params.get('tier') || 4)))
  const moss = params.get('moss')
  if (moss === 'work' || moss === 'idle') {
    const running = moss === 'work'
    API.preview.publish(API.decide({ sessionId: 'preview-session', running,
      modelState: running ? null : { current: { provider: 'openai', model: 'gpt-x' }, groups: [] } }))
  } else {
    API.preview.publish(API.decide(stateFor(tier)))
  }
  if (params.get('cost') === '1') {
    setTimeout(() => document.querySelector('.orb').click(), 260)
  }
</script>
</body></html>`

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = decodeURIComponent(url.pathname)

  if (path === '/' || path === '/preview.html') return send(res, 200, 'text/html; charset=utf-8', PAGE)

  if (path === '/dsh-pet-liang/api/cost') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(SAMPLE_COST))
  }

  if (path === '/dsh-pet-liang/api/bili') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(MOCK_BILI))
  }

  if (path === '/dsh-pet-liang/api/bili-img' || path === '/mock-cover.webp') {
    const cover = join(PLUGIN_DIR, 'assets', 'liang-3.webp')
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' })
    return createReadStream(cover).pipe(res)
  }

  if (path === '/client/client.js') {
    return send(res, 200, 'application/javascript; charset=utf-8',
      require_read(join(PLUGIN_DIR, 'client', 'client.js')))
  }

  if (path.startsWith('/dsh-pet-liang/assets/')) {
    const file = normalize(join(PLUGIN_DIR, 'assets', path.slice('/dsh-pet-liang/assets/'.length)))
    if (!file.startsWith(join(PLUGIN_DIR, 'assets'))) return send(res, 403, 'text/plain', 'forbidden')
    try {
      statSync(file)
    } catch {
      return send(res, 404, 'text/plain', 'not found')
    }
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' })
    return createReadStream(file).pipe(res)
  }

  send(res, 404, 'text/plain', 'not found')
})

import { readFileSync } from 'node:fs'
function require_read(file) {
  return readFileSync(file, 'utf8')
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('dsh-pet-liang preview: http://127.0.0.1:' + PORT + '/')
})
