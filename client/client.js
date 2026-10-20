/**
 * dsh-pet-liang — 浏览器半侧
 *
 * 一个挂在 shell.overlay 外面的浮动桌宠：
 *   - DeepSeek 自带模型 + 空闲 → 梁神（按推理等级四档：小梁 / 梁子 / 梁圣 / 梁神）
 *   - 会话执行中 → 切到 MOSS 工作态（不论模型）
 *   - 非 DeepSeek 模型 + 空闲 → MOSS 空闲态
 *   - 梁神 ↔ MOSS 切换有全息换形动画
 *   - 点击形象弹出当前会话费用（token 分档 + 人民币折算 + 峰谷）
 *
 * 宿主契约：
 *   - slot：conversation.input.dock（session 作用域，拿 sessionId 与 hooks）
 *   - 视觉：自己往 document.body 追加固定层，不占布局、不受 composer 的 transform 影响
 *   - 数据：ctx.modelDirectories（模型目录/推理档位）+ /dsh-pet-liang/api/cost（宿主侧算账）
 */

window.__ModuleLoader__.load({
  id: 'dsh-pet-liang',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = null
    try {
      react = require('react')
    } catch (e) {
      react = null
    }
    var h = react ? react.createElement : null
    var useMemo = react ? react.useMemo : null
    var useEffect = react ? react.useEffect : null
    var useRef = react ? react.useRef : null
    var useSyncExternalStore = react ? react.useSyncExternalStore : null

    var BASE = '/dsh-pet-liang'
    var ROOT_ID = 'dsh-pet-liang-root'
    var POS_KEY = 'dsh-pet-liang:pos'
    /* 素材改了名字没变，加一个版本号强制浏览器重新取（宿主给的是 immutable 缓存） */
    var ASSET_V = '69'
    var STYLE_ID = 'dsh-pet-liang-style'

    /** 四档推理等级对应的称呼与氛围色。 */
    var LIANG_TIERS = [
      { name: '小梁', aura: '#7f8ea3', glow: 0.25, note: '低推理' },
      { name: '梁子', aura: '#a9b7c9', glow: 0.38, note: '中低推理' },
      { name: '梁圣', aura: '#d8b25a', glow: 0.62, note: '高推理' },
      { name: '梁神', aura: '#ffcf5c', glow: 0.9, note: '最高推理' },
    ]

    /* ────────────────────────── 纯逻辑（可单测） ────────────────────────── */

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /** 推理档位在拿不到模型目录时的兜底排序（0..1）。 */
    var EFFORT_RANK = {
      off: 0,
      none: 0,
      on: 0.2,
      auto: 0.5,
      standard: 0.5,
      minimal: 0.15,
      minimal_effort: 0.15,
      low: 0.35,
      medium: 0.55,
      deep: 0.86,
      thinking: 0.86,
      high: 0.86,
      xhigh: 1,
      max: 1,
      extreme: 1,
    }

    /**
     * 会话投影 `modelSelection` → 统一的选择结构。
     * 投影形状是 { lastUsed, next }，不是裸选择；next 为空就退回 lastUsed。
     */
    function selectionFromProjection(value) {
      if (!value || typeof value !== 'object') return null
      var picked = value.next || value.lastUsed || null
      if (!picked || typeof picked !== 'object') return null
      return {
        provider: String(picked.provider || ''),
        model: String(picked.model || ''),
        effort: String(picked.reasoningEffort || ''),
        efforts: [],
        defaultEffort: '',
        modelLabel: String(picked.model || ''),
      }
    }

    /** 档位：优先按模型目录给出的档位序列归一，否则按已知档位名排序。 */
    function tierOf(selection) {
      if (!selection) return 2
      var efforts = selection.efforts || []
      if (efforts.length > 1) return tierForSelection(selection)
      var id = String(selection.effort || selection.defaultEffort || '').toLowerCase()
      if (!id) return 2
      var ratio = EFFORT_RANK[id]
      if (ratio === undefined) return 2
      return 1 + clamp(Math.round(ratio * 3), 0, 3)
    }

    /** 模型目录快照 → 当前选择与可用推理档位。 */
    function readSelection(state) {
      if (!state || typeof state !== 'object') return null
      var current = state.current || null
      var groups = Array.isArray(state.groups) ? state.groups : []
      var group = current ? groups.find((item) => item && item.id === current.provider) : null
      var models = group && Array.isArray(group.models) ? group.models : []
      var model = current ? models.find((item) => item && item.id === current.model) : null
      var reasoning = (model && model.reasoning) || null
      return {
        provider: current ? String(current.provider || '') : '',
        model: current ? String(current.model || '') : '',
        effort: current ? String(current.reasoningEffort || '') : '',
        efforts: reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [],
        defaultEffort: reasoning ? String(reasoning.defaultEffort || '') : '',
        modelLabel: model && model.label ? String(model.label) : current ? String(current.model || '') : '',
      }
    }

    /** 推理档位 → 1..4 档梁神。档位数 ≤1 时落到中间档，避免单档模型永远显示极值。 */
    function tierForSelection(selection) {
      if (!selection) return 2
      var efforts = selection.efforts || []
      if (efforts.length <= 1) return 2
      var wanted = selection.effort || selection.defaultEffort
      var index = wanted ? efforts.findIndex((item) => item && item.id === wanted) : -1
      if (index < 0) index = efforts.length - 1
      var ratio = index / (efforts.length - 1)
      return 1 + clamp(Math.round(ratio * 3), 0, 3)
    }

    /**
     * 状态决议：执行中永远是 MOSS 工作态；空闲时 DeepSeek 模型给梁神，其它模型给 MOSS。
     * 返回的是「完整可渲染状态」，方便直接 diff。
     */
    /** 调试：localStorage['dsh-pet-liang:force'] = 'moss' | 'moss-work' 可强制形象 */
    function forcedState() {
      try {
        var v = window.localStorage.getItem('dsh-pet-liang:force')
        if (!v) return null
        if (v === 'moss' || v === 'moss-work') {
          var working = v === 'moss-work'
          return {
            character: 'moss',
            working: working,
            asset: working ? 'moss-work.webp' : 'moss-base.webp',
            title: 'MOSS',
            subtitle: working ? '执行中' : '空闲',
            aura: '#5ee7ff',
            glow: working ? 0.8 : 0.4,
            provider: '',
            model: '',
            effort: '',
            tier: 0,
          }
        }
      } catch (e) { /* noop */ }
      return null
    }

    function decide(input) {
      const forced = forcedState()
      if (forced) return forced
      var selection = (input && input.selection) || readSelection(input && input.modelState)
      var provider = selection ? selection.provider : ''
      /* provider 拿不到时默认按 DeepSeek 处理：DSH 自带的就只有 DeepSeek，
         读不到就显示 MOSS 会让「用了 DeepSeek 却没梁神」变成常态。 */
      var isDeepSeek = provider ? /deepseek/i.test(provider) : true
      var running = !!(input && input.running)
      var tier = tierOf(selection)
      var meta = LIANG_TIERS[tier - 1]
      var decision = {
        sessionId: (input && input.sessionId) || '',
        running: running,
        isDeepSeek: isDeepSeek,
        provider: provider,
        model: selection ? selection.model : '',
        modelLabel: selection ? selection.modelLabel : '',
        effort: selection ? selection.effort : '',
        tier: tier,
        character: 'moss',
        asset: 'moss-base.webp',
        title: 'MOSS',
        subtitle: '空闲',
        aura: '#5ee7ff',
        glow: 0.45,
        working: false,
      }
      if (running) {
        decision.character = 'moss'
        decision.asset = 'moss-work.webp'
        decision.title = 'MOSS'
        decision.subtitle = '执行中'
        decision.aura = '#5ee7ff'
        decision.glow = 0.85
        decision.working = true
        return decision
      }
      if (isDeepSeek) {
        decision.character = 'liang'
        decision.asset = 'liang-' + tier + '.webp'
        decision.title = meta.name
        decision.subtitle = meta.note
        decision.aura = meta.aura
        decision.glow = meta.glow
        return decision
      }
      return decision
    }

    /* ────────────────────────── 状态广播 ────────────────────────── */

    var listeners = new Set()
    var current = decide({ sessionId: '', running: false, modelState: null })

    function getState() {
      return current
    }

    function publish(next) {
      var keys = ['character', 'asset', 'title', 'subtitle', 'aura', 'glow', 'working', 'tier', 'sessionId', 'model', 'provider', 'modelLabel', 'isDeepSeek']
      var changed = keys.some((key) => next[key] !== current[key])
      current = next
      if (!changed) return
      listeners.forEach((listener) => {
        try {
          listener(current)
        } catch (e) {
          /* noop */
        }
      })
    }

    function subscribe(listener) {
      listeners.add(listener)
      return function () {
        listeners.delete(listener)
      }
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    var CSS = [
      '#' + ROOT_ID + '{position:fixed;right:22px;bottom:104px;width:176px;z-index:2147483000;',
      'font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;color:#e8edf5;',
      'user-select:none;-webkit-user-select:none;pointer-events:auto;touch-action:none;}',
      'body:not([data-ds-dark-theme]) #' + ROOT_ID + '{color:#1b2430;}',

      '#' + ROOT_ID + ' .stage{position:relative;width:176px;height:196px;cursor:grab;',
      'display:flex;align-items:flex-end;justify-content:center;}',
      '#' + ROOT_ID + '.is-dragging .stage{cursor:grabbing;}',

      '#' + ROOT_ID + ' .aura{position:absolute;left:50%;bottom:18px;width:190px;height:150px;z-index:0;',
      'transform:translateX(-50%);border-radius:50%;filter:blur(22px);opacity:.18;',
      'background:radial-gradient(circle at 50% 50%,var(--dpl-aura) 0%,transparent 68%);',
      'animation:pet-breathe 4.6s ease-in-out infinite;}',
      'body[data-ds-dark-theme] #' + ROOT_ID + ' .aura{opacity:.5;}',
      '#' + ROOT_ID + '[data-working="1"] .aura{animation-duration:1.8s;}',

      '#' + ROOT_ID + ' .ring{position:absolute;left:50%;bottom:4px;width:92px;height:14px;z-index:1;',
      'transform:translateX(-50%);border-radius:50%;pointer-events:none;opacity:.55;',
      'background:radial-gradient(ellipse at center,rgba(0,0,0,.34) 0%,rgba(0,0,0,.16) 55%,transparent 78%);',
      'filter:blur(3px);animation:pet-ring 4.6s ease-in-out infinite;}',
      'body[data-ds-dark-theme] #' + ROOT_ID + ' .ring{opacity:.75;',
      'background:radial-gradient(ellipse at center,color-mix(in srgb,var(--dpl-aura) 45%,rgba(0,0,0,.5)) 0%,transparent 72%);}',
      '#' + ROOT_ID + '[data-working="1"] .ring{animation-duration:1.6s;}',

      '#' + ROOT_ID + ' .body{position:relative;z-index:2;display:flex;align-items:flex-end;justify-content:center;',
      'transform-origin:50% 4%;animation:pet-sway 5.6s ease-in-out infinite;}',
      '#' + ROOT_ID + '[data-character="liang"] .body{transform-origin:50% 100%;animation-name:pet-float;}',
      '#' + ROOT_ID + '[data-working="1"] .body{animation-duration:2.4s;}',
      '#' + ROOT_ID + ' .figwrap{position:relative;z-index:2;display:flex;align-items:flex-end;justify-content:center;}',
      '#' + ROOT_ID + ' .moss3d{position:absolute;left:0;bottom:16px;width:100%;height:100%;z-index:4;display:none;}',
      '#' + ROOT_ID + ' .moss3d.on{display:block;}',
      '#' + ROOT_ID + ' .forearm{position:absolute;left:0;bottom:16px;width:100%;height:auto;z-index:3;',
      'pointer-events:none;display:none; /* PNG 兜底不做关节动效：切图旋转会导致机身与手臂分离 */',
      '-webkit-mask-image:linear-gradient(to bottom,#000 92%,transparent 100%);',
      'mask-image:linear-gradient(to bottom,#000 92%,transparent 100%);}',
      '#' + ROOT_ID + '[data-working="1"] .forearm{opacity:0;animation:none;}',
      '#' + ROOT_ID + '[data-character="liang"] .forearm{display:none;}',
      '#' + ROOT_ID + ' .figure{position:relative;z-index:2;max-height:188px;max-width:150px;width:auto;',
      'margin-bottom:16px;filter:drop-shadow(0 10px 20px rgba(0,0,0,.30));',
      '-webkit-mask-image:linear-gradient(to bottom,#000 90%,transparent 100%);',
      'mask-image:linear-gradient(to bottom,#000 90%,transparent 100%);}',

      /* MOSS 工作态：红光由 CSS 叠在镜头上，图片本身是干净的 */
      '#' + ROOT_ID + ' .core{position:absolute;z-index:4;left:43.5%;top:56.5%;width:58px;height:58px;',
      'transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;opacity:0;',
      'background:radial-gradient(circle,rgba(255,72,40,.98) 0%,rgba(255,96,40,.55) 38%,transparent 72%);',
      'filter:blur(4px);transition:opacity .4s ease;}',
      '#' + ROOT_ID + '[data-character="moss"][data-working="1"] .core{opacity:1;animation:pet-core 1.25s ease-in-out infinite;}',
      '#' + ROOT_ID + '[data-character="moss"][data-working="1"] .core::after{content:"";position:absolute;inset:-14px;border-radius:50%;',
      'background:radial-gradient(circle,rgba(255,120,60,.35) 0%,transparent 70%);animation:pet-core-halo 1.25s ease-in-out infinite;}',
      '#' + ROOT_ID + '[data-character="liang"] .core{display:none;}',

      '#' + ROOT_ID + '.is-switching .figure{animation:pet-swap .72s ease-in-out;}',
      '#' + ROOT_ID + '.is-switching .aura{animation:pet-flash .72s ease-in-out;}',

      '#' + ROOT_ID + ' .hud{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:2px;',
      'font-size:11px;letter-spacing:.03em;}',
      '#' + ROOT_ID + ' .name{font-weight:700;color:var(--dpl-aura);}',
      '#' + ROOT_ID + ' .state{opacity:.7;}',
      '#' + ROOT_ID + ' .model{max-width:86px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.42;font-size:10px;',
      'padding-left:5px;border-left:1px solid color-mix(in srgb,var(--dpl-aura) 30%,transparent);}',
      '#' + ROOT_ID + ' .model[data-unknown="1"]{opacity:.65;color:#c98b3a;}',

      '@keyframes pet-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
      '@keyframes pet-sway{0%,100%{transform:rotate(-1.6deg) translateY(0)}25%{transform:rotate(0deg) translateY(-3px)}50%{transform:rotate(1.6deg) translateY(0)}75%{transform:rotate(0deg) translateY(3px)}}',
      '@keyframes pet-breathe{0%,100%{opacity:.18;transform:translateX(-50%) scale(1)}50%{opacity:.42;transform:translateX(-50%) scale(1.07)}}',
      '@keyframes pet-ring{0%,100%{transform:translateX(-50%) scaleX(1) scaleY(1);opacity:.28}50%{transform:translateX(-50%) scaleX(1.12) scaleY(1.3);opacity:.7}}',
      '@keyframes pet-arm{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}',
      '@keyframes pet-core{0%,100%{opacity:.6;transform:translate(-50%,-50%) scale(.9)}45%{opacity:1;transform:translate(-50%,-50%) scale(1.18)}}',
      '@keyframes pet-core-halo{0%,100%{opacity:.25;transform:scale(.9)}45%{opacity:.7;transform:scale(1.25)}}',
      '@keyframes pet-swap{0%{opacity:1;filter:blur(0)}38%{opacity:.12;filter:blur(5px)}70%{opacity:0;filter:blur(9px)}100%{opacity:1;filter:blur(0)}}',
      '@keyframes pet-flash{0%,100%{opacity:.2}45%{opacity:.95;filter:blur(30px)}}',
    ].join('')

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ────────────────────────── 浮动层 ────────────────────────── */

    var overlay = null
    var switchTimers = []
    var biliOpen = false
    var biliKind = 'new'
    var biliQuery = ''
    var biliPage = 1
    var biliRid = 0
    var biliMode = 'list'
    var biliList = null
    var biliError = ''
    var biliCurrent = null

    function assetUrl(file) {
      return BASE + '/assets/' + file + '?v=' + ASSET_V
    }

    function el(tag, cls, text) {
      var node = document.createElement(tag)
      if (cls) node.className = cls
      if (text !== undefined && text !== null) node.textContent = text
      return node
    }

    /* ── 拖动：pointer 事件 + localStorage 记忆位置 ── */

    var dragState = null
    var suppressClick = false

    function placeAt(root, x, y) {
      var maxX = Math.max(0, window.innerWidth - root.offsetWidth)
      var maxY = Math.max(0, window.innerHeight - root.offsetHeight)
      root.style.left = Math.round(Math.min(Math.max(0, x), maxX)) + 'px'
      root.style.top = Math.round(Math.min(Math.max(0, y), maxY)) + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }

    function restorePosition(root) {
      try {
        var raw = window.localStorage.getItem(POS_KEY)
        if (!raw) return
        var pos = JSON.parse(raw)
        if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return
        placeAt(root, pos.x, pos.y)
      } catch (e) {
        /* 无痕模式 / 存储被禁：保持默认右下角 */
      }
    }

    function savePosition(root) {
      try {
        var rect = root.getBoundingClientRect()
        window.localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }))
      } catch (e) {
        /* noop */
      }
    }

    function bindDrag(root) {
      root.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        var rect = root.getBoundingClientRect()
        root.style.left = rect.left + 'px'
        root.style.top = rect.top + 'px'
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        dragState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originLeft: rect.left,
          originTop: rect.top,
          moved: false,
        }
        root.classList.add('is-dragging')
      })

      document.addEventListener('pointermove', function (event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return
        var dx = event.clientX - dragState.startX
        var dy = event.clientY - dragState.startY
        if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 5) return
        dragState.moved = true
        placeAt(root, dragState.originLeft + dx, dragState.originTop + dy)
        if (event.cancelable) event.preventDefault()
      })

      function finish(event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return
        var moved = dragState.moved
        dragState = null
        root.classList.remove('is-dragging')
        if (!moved) return
        /* 拖过就别再当成点击，否则松手瞬间会弹出费用卡 */
        suppressClick = true
        window.setTimeout(function () {
          suppressClick = false
        }, 0)
        savePosition(root)
      }

      document.addEventListener('pointerup', finish)
      document.addEventListener('pointercancel', finish)

      window.addEventListener('resize', function () {
        if (!root.style.left) return
        var rect = root.getBoundingClientRect()
        placeAt(root, rect.left, rect.top)
      })
    }

    var moss3d = null
    var moss3dBroken = false
    var moss3dTried = false

    var moss3dFailed = null

    /** 3D 不可用时在 HUD 上显示原因，便于排查（不静默降级） */
    function mark3dFailed(err) {
      moss3dFailed = String((err && err.message) || err || 'unknown').slice(0, 40)
      try { console.error('[dsh-pet-liang] 3D 不可用：', err) } catch (e) { /* noop */ }
      if (overlay) {
        var node = overlay.querySelector('.model')
        if (node) {
          node.textContent = '3D失败'
          node.setAttribute('data-unknown', '1')
          node.title = moss3dFailed
        }
      }
    }

    function ensure3d(canvas) {
      if (moss3d || moss3dBroken || moss3dTried) return
      moss3dTried = true
      var boot = BASE + '/3d/boot.js?v=' + ASSET_V
      import(boot).then(function (mod) {
        moss3d = mod.createMoss3D(canvas, {
          base: BASE + '/3d/',
          ver: ASSET_V,
          onError: function (err) {
            moss3dBroken = true
            canvas.classList.remove('ready')
            mark3dFailed(err)
          },
        })
        canvas.classList.add('ready')
        if (current) paint(current, false)
      }).catch(function (err) {
        moss3dBroken = true
        canvas.classList.remove('ready')
        mark3dFailed(err)
      })
    }

    function buildOverlay() {
      ensureStyle()
      var existing = document.getElementById(ROOT_ID)
      if (existing) return existing

      var root = el('div')
      root.id = ROOT_ID
      root.setAttribute('data-character', 'moss')
      root.setAttribute('data-working', '0')

      var stage = el('div', 'stage')
      var aura = el('div', 'aura')
      var ring = el('div', 'ring')
      var core = el('div', 'core')
      var body = el('div', 'body')
      var figwrap = el('div', 'figwrap')
      var figure = el('img', 'figure')
      figure.src = assetUrl('moss-base.webp')
      figure.alt = ''
      figure.draggable = false
      figure.setAttribute('data-asset', 'moss-base.webp')
      figure.setAttribute('data-char', 'moss')
      var canvas3d = document.createElement('canvas')
      canvas3d.className = 'moss3d'
      var forearm = el('img', 'forearm')
      forearm.src = assetUrl('moss-forearm.webp')
      forearm.alt = ''
      forearm.draggable = false
      figwrap.appendChild(figure)
      figwrap.appendChild(forearm)
      figwrap.appendChild(canvas3d)
      body.appendChild(figwrap)
      body.appendChild(core)
      stage.appendChild(aura)
      stage.appendChild(ring)
      stage.appendChild(body)

      var hud = el('div', 'hud')
      var nameNode = el('span', 'name', 'MOSS')
      var stateNode = el('span', 'state', '空闲')
      var modelNode = el('span', 'model', '')
      hud.appendChild(nameNode)
      hud.appendChild(stateNode)
      hud.appendChild(modelNode)

      root.appendChild(stage)
      root.appendChild(hud)

      /* 点击判定放在 root 上：pointer capture 会把 click 重定向到捕获元素，
         挂在 stage 上会收不到。费用卡内部点击不触发开关。 */
      root.addEventListener('click', function (event) {
        event.stopPropagation()
        if (suppressClick) return
        void toggleBili()
      })
      /* 不再「点外面就关」：拖动/缩放结束时的 click 会误伤，关窗只用 × / Esc / 再点一次桌宠 */
      document.addEventListener('keydown', function (event) {
        if (!biliOpen || event.key !== 'Escape') return
        if (biliMode === 'player') {
          biliMode = 'list'
          biliCurrent = null
          renderBili()
        } else {
          closeBili()
        }
      })

      ;['moss-base.webp', 'moss-forearm.webp', 'moss-work.webp'].forEach(function (name) {
        try { var img = new Image(); img.src = assetUrl(name) } catch (e) { /* noop */ }
      })

      document.body.appendChild(root)
      restorePosition(root)
      bindDrag(root)
      overlay = root
      paint(current, false)
      return root
    }

    function clearSwitchTimers() {
      switchTimers.forEach(function (id) {
        window.clearTimeout(id)
      })
      switchTimers = []
    }

    function paint(state, animate) {
      if (!overlay) return
      overlay.style.setProperty('--dpl-aura', state.aura)
      overlay.setAttribute('data-character', state.character)
      overlay.setAttribute('data-working', state.working ? '1' : '0')
      overlay.setAttribute('data-tier', String(state.tier))
      overlay.setAttribute('data-provider', state.provider || '')
      /* 悬浮可看到当前判定的模型/档位，出问题时不用开控制台 */
      overlay.title =
        (state.modelLabel || state.model || '未知模型') +
        (state.effort ? ' · ' + state.effort : '') +
        (state.provider ? ' · ' + state.provider : '') +
        (state.character === 'liang' ? ' · ' + state.title : ' · MOSS')

      var figure = overlay.querySelector('.figure')
      var nameNode = overlay.querySelector('.name')
      var stateNode = overlay.querySelector('.state')
      var modelNode = overlay.querySelector('.model')
      var aura = overlay.querySelector('.aura')

      if (nameNode) nameNode.textContent = state.title
      if (stateNode) stateNode.textContent = state.subtitle
      if (modelNode) {
        var tag = state.model || state.provider || ''
        if (tag) tag = tag.replace(/^deepseek[-_]?/i, '') + (state.effort ? ' · ' + state.effort : '')
        modelNode.textContent = tag || '模型未知'
        modelNode.setAttribute('data-unknown', tag ? '0' : '1')
      }
      if (aura) aura.style.background = 'radial-gradient(circle,' + state.aura + ' 0%, transparent 68%)'
      if (aura) aura.style.opacity = String(0.3 + state.glow * 0.55)



      var c3d = overlay.querySelector('.moss3d')
      if (c3d) {
        if (state.character === 'moss' && !moss3dBroken) ensure3d(c3d)
        var use3d = state.character === 'moss' && c3d.classList.contains('ready')
        c3d.classList.toggle('on', use3d)
        if (moss3d) {
          moss3d.setWorking(!!state.working)
          if (moss3d.setActive) moss3d.setActive(use3d)
        }
        if (figure) figure.style.visibility = use3d ? 'hidden' : ''
        var fa = overlay.querySelector('.forearm')
        if (fa) fa.style.visibility = use3d ? 'hidden' : ''
        var coreEl = overlay.querySelector('.core')
        if (coreEl) coreEl.style.display = use3d ? 'none' : ''
      }

      if (!figure) return
      var nextChar = state.character
      var nextAsset = state.asset
      var prevChar = figure.getAttribute('data-char')
      var prevAsset = figure.getAttribute('data-asset')

      if (prevChar !== nextChar) {
        /* 角色换形：先播放扫描/溶解，动画中点切换素材，画面上读作「重构成另一种形态」。
           连续快速切换时先作废上一轮定时器，并且只在「目标仍是当前状态」时落素材，避免串帧。 */
        if (animate) {
          clearSwitchTimers()
          overlay.classList.add('is-switching')
          switchTimers.push(window.setTimeout(function () {
            if (current.character !== nextChar || current.asset !== nextAsset) return
            figure.src = assetUrl(nextAsset)
            figure.setAttribute('data-asset', nextAsset)
            figure.setAttribute('data-char', nextChar)
          }, 300))
          switchTimers.push(window.setTimeout(function () {
            overlay.classList.remove('is-switching')
          }, 820))
        } else {
          figure.src = assetUrl(nextAsset)
          figure.setAttribute('data-asset', nextAsset)
          figure.setAttribute('data-char', nextChar)
        }
      } else if (prevAsset !== nextAsset) {
        /* 同角色换档（梁子→梁圣）：短淡入，不做整段换形 */
        clearSwitchTimers()
        overlay.classList.remove('is-switching')
        figure.style.transition = 'opacity .18s ease'
        figure.style.opacity = '0.35'
        window.setTimeout(function () {
          figure.src = assetUrl(nextAsset)
          figure.setAttribute('data-asset', nextAsset)
          figure.style.opacity = '1'
        }, 140)
      }
    }

    /* ────────────────────────── B 站小窗 ────────────────────────── */

    var BW_ID = 'dsh-pet-liang-bili'
    var BW_STATE_KEY = 'dsh-pet-liang:bili-window'

    var bw = null                 // 窗口根节点
    var biliOpen = false
    var biliKind = 'new'
    var biliQuery = ''
    var biliPage = 1
    var biliRid = 0
    var biliMode = 'list'
    var biliList = null
    var biliError = ''
    var biliCurrent = null
    var bwDrag = null

    function bwStyle() {
      return [
        '#' + BW_ID + '{position:fixed;z-index:2147483200;display:flex;flex-direction:column;',
        'border-radius:14px;overflow:hidden;color:#e8edf5;',
        'background:rgba(13,17,23,.96);',
        'border:1px solid color-mix(in srgb,var(--dpl-aura,#7f8ea3) 32%,transparent);',
        'box-shadow:0 22px 60px rgba(0,0,0,.55);backdrop-filter:blur(16px);',
        'font-family:ui-sans-serif,system-ui,"PingFang SC",sans-serif;}',
        '#' + BW_ID + '[hidden]{display:none;}',
        '#' + BW_ID + ' .bw-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;flex:none;',
        'border-bottom:1px solid rgba(255,255,255,.07);touch-action:none;}',
        '#' + BW_ID + '.bw-dragging .bw-head{cursor:grabbing;}',
        '#' + BW_ID + ' .bw-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;',
        'color:var(--dpl-aura,#7f8ea3);}',
        '#' + BW_ID + ' .bw-head{flex-direction:column;align-items:stretch;gap:6px;padding:8px 10px 7px;height:auto;}',
        '#' + BW_ID + ' .bw-head-top{display:flex;align-items:center;gap:6px;}',
        '#' + BW_ID + ' .bw-tools{display:flex;align-items:center;gap:5px;margin-left:auto;}',
        '#' + BW_ID + ' .bw-search{display:flex;gap:6px;}',
        '#' + BW_ID + ' .bw-channels{display:flex;align-items:center;gap:5px;}',
        '#' + BW_ID + ' .bw-cat{font:inherit;font-size:10.5px;padding:3px 5px;border-radius:6px;color:#e8edf5;',
        'background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.12);outline:none;cursor:pointer;}',
        '#' + BW_ID + ' .bw-cat option{background:#131820;color:#e8edf5;}',
        '#' + BW_ID + ' .bw-input{flex:1;min-width:0;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 10px;font-size:12px;',
        'outline:none;background:rgba(255,255,255,.08);color:#e8edf5;}',
        '#' + BW_ID + ' .bw-input::placeholder{color:rgba(232,237,245,.38);}',
        '#' + BW_ID + ' .bw-go,#' + BW_ID + ' .bw-refresh,#' + BW_ID + ' .bw-clear{font:inherit;font-size:10.5px;padding:3px 7px;',
        'border-radius:6px;cursor:pointer;color:#c9d3df;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);}',
        '#' + BW_ID + ' .bw-go:hover,#' + BW_ID + ' .bw-refresh:hover,#' + BW_ID + ' .bw-clear:hover{color:#fff;background:rgba(255,255,255,.12);}',
        '#' + BW_ID + ' .bw-refresh.spin{animation:bw-spin .8s linear infinite;}',
        '#' + BW_ID + ' .bw-tabs{display:flex;gap:4px;margin-left:auto;}',
        '#' + BW_ID + ' .bw-tabs button,#' + BW_ID + ' .bw-close{font:inherit;font-size:10.5px;padding:3px 8px;',
        'border-radius:6px;cursor:pointer;color:#9aa7b8;',
        'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);}',
        '#' + BW_ID + ' .bw-tabs button[data-active="1"]{color:#0b0e13;background:var(--dpl-aura,#7f8ea3);border-color:transparent;}',
        '#' + BW_ID + ' .bw-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;}',
        '#' + BW_ID + ' .bw-body.bw-body--play{overflow:hidden;display:flex;flex-direction:column;}',
        '#' + BW_ID + ' .bw-body::-webkit-scrollbar{width:8px;}',
        '#' + BW_ID + ' .bw-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:4px;}',
        '#' + BW_ID + ' .bw-item{display:flex;gap:9px;padding:8px 10px;cursor:pointer;align-items:center;}',
        '#' + BW_ID + ' .bw-item:hover{background:rgba(255,255,255,.06);}',
        '#' + BW_ID + ' .bw-item img{width:92px;height:58px;object-fit:cover;border-radius:7px;flex:none;background:rgba(255,255,255,.06);}',
        '#' + BW_ID + ' .bw-meta{min-width:0;flex:1;}',
        '#' + BW_ID + ' .bw-name{font-size:12px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
        '#' + BW_ID + ' .bw-sub{font-size:10px;opacity:.5;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '#' + BW_ID + ' .bw-note{padding:18px 14px;font-size:11.5px;opacity:.7;text-align:center;line-height:1.6;}',
        '#' + BW_ID + ' .bw-play{position:relative;flex:1;min-height:0;background:#000;}',
        '#' + BW_ID + ' .bw-play iframe{display:block;width:100%;height:100%;border:0;background:#000;}',
        '#' + BW_ID + ' .bw-back{position:absolute;left:8px;top:8px;z-index:2;font-size:10.5px;padding:3px 8px;border-radius:6px;',
        'cursor:pointer;color:#e8edf5;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.16);}',
        '#' + BW_ID + ' .bw-foot{padding:6px 10px;font-size:9.5px;opacity:.45;border-top:1px solid rgba(255,255,255,.07);flex:none;}',
        '@keyframes bw-spin{to{transform:rotate(360deg)}}',
        '#' + BW_ID + ' .bw-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:se-resize;touch-action:none;}',
        '#' + BW_ID + ' .bw-resize::after{content:"";position:absolute;right:4px;bottom:4px;width:8px;height:8px;',
        'border-right:2px solid rgba(255,255,255,.35);border-bottom:2px solid rgba(255,255,255,.35);border-bottom-right-radius:3px;}',
      ].join('')
    }

    function ensureBwStyle() {
      if (document.getElementById(BW_ID + '-style')) return
      var style = document.createElement('style')
      style.id = BW_ID + '-style'
      style.textContent = bwStyle()
      document.head.appendChild(style)
    }

    function loadBwState() {
      try {
        var raw = window.localStorage.getItem(BW_STATE_KEY)
        return raw ? JSON.parse(raw) : null
      } catch (e) {
        return null
      }
    }

    function saveBwState(rect) {
      try {
        window.localStorage.setItem(BW_STATE_KEY, JSON.stringify({
          x: Math.round(rect.left), y: Math.round(rect.top),
          w: Math.round(rect.width), h: Math.round(rect.height),
        }))
      } catch (e) { /* noop */ }
    }

    function defaultBwRect() {
      var vw = window.innerWidth || 1280
      var vh = window.innerHeight || 800
      var pet = overlay ? overlay.getBoundingClientRect() : null
      var w = Math.min(420, Math.max(340, Math.round(vw * 0.32)))
      var h = Math.min(600, Math.max(420, Math.round(vh * 0.68)))
      var x = pet ? Math.max(12, Math.round(pet.left - w - 20)) : Math.round(vw - w - 260)
      var y = pet ? Math.max(12, Math.round(Math.min(pet.top, vh - h - 12))) : 80
      return { x: x, y: y, w: w, h: h }
    }

    function clampBwRect(rect) {
      var vw = window.innerWidth || 1280
      var vh = window.innerHeight || 800
      var w = Math.max(320, Math.min(rect.w, vw - 24))
      var h = Math.max(360, Math.min(rect.h, vh - 24))
      var x = Math.max(8, Math.min(rect.x, vw - w - 8))
      var y = Math.max(8, Math.min(rect.y, vh - h - 8))
      return { x: x, y: y, w: w, h: h }
    }

    function applyBwRect(rect) {
      if (!bw) return
      bw.style.left = rect.x + 'px'
      bw.style.top = rect.y + 'px'
      bw.style.width = rect.w + 'px'
      bw.style.height = rect.h + 'px'
    }

    function ensureBw() {
      if (bw) return bw
      ensureBwStyle()
      var win = el('div')
      win.id = BW_ID
      win.hidden = true

      var head = el('div', 'bw-head')
      var headTop = el('div', 'bw-head-top')
      headTop.appendChild(el('span', 'bw-title', 'Bilibili'))
      var headTools = el('div', 'bw-tools')

      var searchWrap = el('div', 'bw-search')
      var input = document.createElement('input')
      input.className = 'bw-input'
      input.type = 'search'
      input.placeholder = '搜索视频，回车确认'
      input.addEventListener('keydown', function (event) {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          doSearch(input.value)
        }
      })
      var go = el('button', 'bw-go', '搜索')
      go.type = 'button'
      go.addEventListener('click', function (event) {
        event.stopPropagation()
        doSearch(input.value)
      })
      searchWrap.appendChild(input)
      searchWrap.appendChild(go)
      head.appendChild(headTop)

      var refresh = el('button', 'bw-refresh', '↻')
      refresh.type = 'button'
      refresh.title = '刷新'
      refresh.addEventListener('click', function (event) {
        event.stopPropagation()
        if (biliMode === 'player') {
          biliMode = 'list'
          biliCurrent = null
        }
        biliList = null
        biliError = ''
        if (!biliQuery && biliKind === 'hot') biliPage = biliPage >= 5 ? 1 : biliPage + 1
        renderBili()
        void loadBili()
      })
      headTools.appendChild(refresh)

      var close = el('button', 'bw-close', '×')
      close.type = 'button'
      close.addEventListener('click', function (event) {
        event.stopPropagation()
        closeBili()
      })
      headTools.appendChild(close)
      headTop.appendChild(headTools)
      head.appendChild(searchWrap)

      var channelRow = el('div', 'bw-channels')
      var cats = [['0','全站'],['1','动画'],['3','音乐'],['4','游戏'],['5','娱乐'],['36','知识'],['188','科技'],['181','影视'],['119','鬼畜'],['160','生活'],['211','美食']]
      var catSel = document.createElement('select')
      catSel.className = 'bw-cat'
      cats.forEach(function (pair) {
        var opt = document.createElement('option')
        opt.value = pair[0]
        opt.textContent = pair[1]
        catSel.appendChild(opt)
      })
      catSel.addEventListener('change', function (event) {
        event.stopPropagation()
        biliRid = Number(catSel.value) || 0
        biliQuery = ''
        input.value = ''
        biliList = null
        biliPage = 1
        biliMode = 'list'
        biliCurrent = null
        renderBili()
        void loadBili()
      })
      channelRow.appendChild(catSel)

      var tabs = el('div', 'bw-tabs')
      ;[['new', '最新'], ['hot', '热门'], ['rank', '排行']].forEach(function (pair) {
        var button = el('button', '', pair[1])
        button.type = 'button'
        button.setAttribute('data-kind', pair[0])
        button.addEventListener('click', function (event) {
          event.stopPropagation()
          biliQuery = ''
          if (biliKind === pair[0] && biliList) return
          biliKind = pair[0]
          biliPage = 1
          biliList = null
          biliMode = 'list'
          renderBili()
          void loadBili()
        })
        tabs.appendChild(button)
      })
      var clear = el('button', 'bw-clear', '清除搜索')
      clear.type = 'button'
      clear.hidden = true
      clear.addEventListener('click', function (event) {
        event.stopPropagation()
        biliQuery = ''
        biliList = null
        biliMode = 'list'
        renderBili()
        void loadBili()
      })
      tabs.appendChild(clear)
      channelRow.appendChild(tabs)
      head.appendChild(channelRow)

      var body = el('div', 'bw-body')
      var foot = el('div', 'bw-foot', '拖动标题栏移动 · 右下角缩放 · Esc 关闭')
      var grip = el('div', 'bw-resize')

      win.appendChild(head)
      win.appendChild(body)
      win.appendChild(foot)
      win.appendChild(grip)
      win.addEventListener('pointerdown', function (event) { event.stopPropagation() })
      win.addEventListener('click', function (event) { event.stopPropagation() })

      /* 拖动 */
      head.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        /* 标题栏里的输入框 / 下拉 / 按钮不能被拖拽吞掉点击 */
        var t = event.target
        if (t && t.closest && t.closest('input, select, textarea, button')) return
        var rect = win.getBoundingClientRect()
        bwDrag = { mode: 'move', sx: event.clientX, sy: event.clientY, x: rect.left, y: rect.top, w: rect.width, h: rect.height }
        win.classList.add('bw-dragging')
        event.preventDefault()
      })
      /* 缩放 */
      grip.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return
        var rect = win.getBoundingClientRect()
        bwDrag = { mode: 'resize', sx: event.clientX, sy: event.clientY, x: rect.left, y: rect.top, w: rect.width, h: rect.height }
        event.preventDefault()
      })
      document.addEventListener('pointermove', function (event) {
        if (!bwDrag) return
        var dx = event.clientX - bwDrag.sx
        var dy = event.clientY - bwDrag.sy
        var next
        if (bwDrag.mode === 'move') {
          next = clampBwRect({ x: bwDrag.x + dx, y: bwDrag.y + dy, w: bwDrag.w, h: bwDrag.h })
        } else {
          next = clampBwRect({ x: bwDrag.x, y: bwDrag.y, w: bwDrag.w + dx, h: bwDrag.h + dy })
        }
        applyBwRect(next)
      })
      document.addEventListener('pointerup', function () {
        if (!bwDrag) return
        bwDrag = null
        win.classList.remove('bw-dragging')
        var rect = win.getBoundingClientRect()
        saveBwState({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      })

      document.body.appendChild(win)
      bw = win
      return win
    }

    function formatDuration(seconds) {
      var total = Number(seconds) || 0
      var m = Math.floor(total / 60)
      var sec = total % 60
      return m + ':' + (sec < 10 ? '0' + sec : String(sec))
    }

    function formatAgo(pubdate) {
      var ts = Number(pubdate) || 0
      if (!ts) return ''
      var diff = Math.max(0, Math.floor((Date.now() - ts * 1000) / 1000))
      if (diff < 60) return '刚刚'
      if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
      if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
      if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前'
      return new Date(ts * 1000).toLocaleDateString('zh-CN')
    }

    function formatViews(value) {
      var n = Number(value) || 0
      if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
      if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
      return String(n)
    }

    function coverUrl(pic) {
      if (!pic) return ''
      var target = pic.indexOf('//') === 0 ? 'https:' + pic : pic.replace(/^http:\/\//i, 'https://')
      return BASE + '/api/bili-img?u=' + encodeURIComponent(target)
    }

    function doSearch(raw) {
      var keyword = String(raw || '').trim()
      if (!keyword) return
      biliQuery = keyword.slice(0, 60)
      biliList = null
      biliError = ''
      biliMode = 'list'
      biliCurrent = null
      renderBili()
      void loadBili()
    }

    function renderBili() {
      if (!bw) return
      var head = bw.querySelector('.bw-head')
      var body = bw.querySelector('.bw-body')
      var foot = bw.querySelector('.bw-foot')
      if (!head || !body) return

      ;[].forEach.call(head.querySelectorAll('.bw-tabs button[data-kind]'), function (button) {
        if (!biliQuery && button.getAttribute('data-kind') === biliKind) button.setAttribute('data-active', '1')
        else button.removeAttribute('data-active')
      })
      var clearBtn = head.querySelector('.bw-clear')
      if (clearBtn) clearBtn.hidden = !biliQuery

      while (body.firstChild) body.removeChild(body.firstChild)

      if (biliMode === 'player' && biliCurrent) {
        var play = el('div', 'bw-play')
        var back = el('button', 'bw-back', '← 返回')
        back.type = 'button'
        back.addEventListener('click', function (event) {
          event.stopPropagation()
          biliMode = 'list'
          biliCurrent = null
          renderBili()
        })
        play.appendChild(back)
        var frame = document.createElement('iframe')
        frame.allow = 'autoplay; fullscreen; picture-in-picture'
        frame.setAttribute('allowfullscreen', 'true')
        frame.setAttribute('referrerpolicy', 'origin')
        frame.src = 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(biliCurrent.bvid) +
          '&autoplay=1&high_quality=1&danmaku=1&page=1'
        play.appendChild(frame)
        body.appendChild(play)
        body.classList.add('bw-body--play')
        if (foot) foot.textContent = 'Esc 返回列表'
        return
      }

      body.classList.remove('bw-body--play')
      if (foot) foot.textContent = '拖动标题栏移动 · 右下角缩放 · Esc 关闭'

      if (biliError) {
        body.appendChild(el('div', 'bw-note', biliError))
      } else if (!biliList) {
        body.appendChild(el('div', 'bw-note', '正在加载…'))
      } else if (!biliList.length) {
        body.appendChild(el('div', 'bw-note', biliQuery ? ('没有搜到「' + biliQuery + '」相关的视频') : '这一档暂时没有拉到视频'))
      } else {
        biliList.forEach(function (item) {
          var row = el('div', 'bw-item')
          if (item.pic) {
            var thumb = document.createElement('img')
            thumb.loading = 'lazy'
            thumb.alt = ''
            thumb.src = coverUrl(item.pic)
            row.appendChild(thumb)
          }
          var meta = el('div', 'bw-meta')
          meta.appendChild(el('div', 'bw-name', item.title || item.bvid))
          var when = formatAgo(item.pubdate)
          meta.appendChild(el('div', 'bw-sub', (item.owner || '') + ' · ' + formatViews(item.views) + ' 播放 · ' + formatDuration(item.duration) + (when ? ' · ' + when : '')))
          row.appendChild(meta)
          row.addEventListener('click', function (event) {
            event.stopPropagation()
            biliCurrent = item
            biliMode = 'player'
            renderBili()
          })
          body.appendChild(row)
        })
      }
    }

    async function loadBili() {
      biliError = ''
      var endpoint = biliQuery
        ? BASE + '/api/bili-search?keyword=' + encodeURIComponent(biliQuery) + '&_t=' + Date.now()
        : BASE + '/api/bili?kind=' + encodeURIComponent(biliKind) + '&ps=16&pn=' + biliPage + '&rid=' + biliRid + '&_t=' + Date.now()
      try {
        var response = await fetch(endpoint, { headers: { Accept: 'application/json' } })
        var payload = await response.json()
        if (!payload || payload.ok !== true) {
          biliError = 'B 站接口暂时不可达：' + ((payload && payload.error) || '未知错误')
          biliList = []
        } else {
          biliList = Array.isArray(payload.list) ? payload.list : []
        }
      } catch (err) {
        biliError = 'B 站接口暂时不可达：' + String((err && err.message) || err)
        biliList = []
      }
      if (!biliOpen) return
      renderBili()
    }

    function openBili() {
      ensureBw()
      var saved = loadBwState()
      var rect = clampBwRect(saved || defaultBwRect())
      applyBwRect(rect)
      bw.hidden = false
      biliOpen = true
      biliMode = 'list'
      biliCurrent = null
      renderBili()
      if (!biliList) void loadBili()
    }

    function closeBili() {
      if (bw) bw.hidden = true
      biliOpen = false
      biliMode = 'list'
      biliCurrent = null
    }

    function toggleBili() {
      if (biliOpen) closeBili()
      else openBili()
    }

    /* ────────────────────────── 桥：宿主状态 → 浮动层 ────────────────────────── */

    function useModelState(ctx, sessionId) {
      /* directoryFor() 在会话还没绑定 scope 时会抛错；一次性 useMemo 会把「没取到」永久钉住，
         于是 provider 为空 → 一直被判成非 DeepSeek → 永远 MOSS。这里改成带重试的 state。 */
      var pair = react.useState(null)
      var directory = pair[0]
      var setDirectory = pair[1]
      useEffect(function () {
        var cancelled = false
        var tries = 0
        function attempt() {
          if (cancelled || !sessionId) return
          try {
            var service = ctx.modelDirectories
            if (service && typeof service.directoryFor === 'function') {
              var dir = service.directoryFor(sessionId)
              if (dir) {
                setDirectory(dir)
                try {
                  var loaded = typeof dir.load === 'function' ? dir.load() : null
                  if (loaded && typeof loaded.catch === 'function') loaded.catch(function () {})
                } catch (e) { /* noop */ }
                return
              }
            }
          } catch (e) { /* 会话还没 bind，稍后重试 */ }
          tries += 1
          if (tries < 16) window.setTimeout(attempt, 250)
        }
        attempt()
        return function () {
          cancelled = true
        }
      }, [ctx, sessionId])

      var store = directory && directory.store ? directory.store : directory

      var subscribeDir = useMemo(function () {
        return function (listener) {
          try {
            if (store && typeof store.subscribe === 'function') return store.subscribe(listener)
          } catch (e) {
            /* noop */
          }
          return function () {}
        }
      }, [store])

      var readDir = useMemo(function () {
        return function () {
          try {
            return store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
          } catch (e) {
            return null
          }
        }
      }, [store])

      if (!useSyncExternalStore) return null
      return useSyncExternalStore(subscribeDir, readDir, readDir)
    }

    function Bridge(props) {
      var sessionId = props.sessionId
      var useSessionStatus = props.useSessionStatus
      var useSessions = props.useSessions
      var useProjection = props.useProjection
      var ctx = props.ctx

      /* 运行态：状态表优先，没有就读会话摘要里的 running */
      var summary = useSessions
        ? useSessions(function (state) {
            return state && state.byId ? state.byId[sessionId] : undefined
          })
        : undefined

      /* 运行态取两个来源的交集：状态表可能因为某个事件没到而一直停在 running=true，
         会话摘要（Host 列表）通常更早翻成 false，两者都为真才算「在跑」。 */
      var statusRunning
      if (useSessionStatus) {
        statusRunning = useSessionStatus(function (map) {
          if (!map || typeof map.get !== 'function') return undefined
          var row = map.get(sessionId)
          if (!row) return undefined
          return row.running === true
        })
      }
      var summaryRunning = summary ? summary.running === true : undefined
      var running
      if (statusRunning === undefined) running = summaryRunning === true
      else if (summaryRunning === undefined) running = statusRunning
      else running = statusRunning && summaryRunning

      /* 模型：会话投影是权威来源（durable），不依赖目录异步加载 */
      var projected = undefined
      if (useProjection) {
        try {
          projected = useProjection('modelSelection')
        } catch (e) {
          projected = undefined
        }
      }
      var fromProjection = selectionFromProjection(projected)
      var fromSummary = selectionFromProjection(
        summary && summary.projectionValues ? summary.projectionValues.modelSelection : null,
      )
      var selection = fromProjection || fromSummary

      /* 目录只用来补「档位序列」，拿不到也不影响判定 */
      var modelState = useModelState(ctx, sessionId)

      /* 投影里有时只带 provider/model，档位要另找：目录的 current.reasoningEffort 或档位序列 */
      var fromDirectory = readSelection(modelState)
      if (selection && fromDirectory) {
        selection = {
          provider: selection.provider || fromDirectory.provider,
          model: selection.model || fromDirectory.model,
          effort: selection.effort || fromDirectory.effort,
          efforts: selection.efforts.length ? selection.efforts : fromDirectory.efforts,
          defaultEffort: selection.defaultEffort || fromDirectory.defaultEffort,
          modelLabel: selection.modelLabel || fromDirectory.modelLabel,
        }
      } else if (!selection && fromDirectory) {
        selection = fromDirectory
      }

      /* 某些 store 在特定路径下不会通知订阅者，这里给一个低频兜底重算 */
      var tickPair = react.useState(0)
      var tick = tickPair[0]
      var bumpTick = tickPair[1]
      useEffect(function () {
        var timer = window.setInterval(function () {
          if (typeof bumpTick === 'function') bumpTick(function (n) { return n + 1 })
        }, 1500)
        return function () { window.clearInterval(timer) }
      }, [])

      var decision = useMemo(function () {
        return decide({ sessionId: sessionId, running: running, selection: selection, modelState: modelState })
      }, [sessionId, running, selection, modelState, tick])

      useEffect(function () {
        publish(decision)
        try {
          /* 一次性诊断日志：模型判定出问题时，让用户能把这三行贴回来 */
          console.info('[dsh-pet-liang]',
            'session=' + String(sessionId || '(none)'),
            'provider=' + (decision.provider || '(unknown)'),
            'model=' + (decision.model || '(unknown)'),
            'effort=' + (decision.effort || '(default)'),
            'running=' + String(decision.running),
            '→ ' + decision.character + '/' + decision.asset)
        } catch (e) { /* noop */ }
      }, [decision])

      return null
    }

    /* ────────────────────────── 插件装配 ────────────────────────── */

    var inject = ['slots', 'modelDirectories', 'sessions']

    function apply(ctx) {
      try {
        applyImpl(ctx)
      } catch (e) {
        /* 客户端半失败最多是「没有桌宠」，不允许影响已渲染的应用 */
      }
    }

    function applyImpl(ctx) {
      var slots = null
      try {
        slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots
      } catch (e) {
        slots = null
      }

      buildOverlay()
      ensureBw()
      subscribe(function (state) {
        paint(state, true)
      })

      if (!slots || typeof slots.inject !== 'function' || !h) return

      function registerBridge(seat, id, order) {
        try {
          slots.inject(seat, function () {
            return slots.register({ name: seat, id: id, order: order }, function PetBridge(props) {
              return h(Bridge, {
                ctx: ctx,
                sessionId: props.sessionId,
                useSessionStatus: props.useSessionStatus,
                useSessions: props.useSessions,
                useProjection: props.useProjection,
              })
            })
          })
        } catch (e) {
          /* 该座位不存在就换下一个 */
        }
      }

      /* 两个座位互为兜底：只要有一个挂着，桌宠就能拿到当前会话 */
      registerBridge('conversation.input.dock', 'dsh-pet-liang-bridge', 99)
      registerBridge('conversation.session.header.utilities', 'dsh-pet-liang-bridge-2', 99)
    }

    exports.apply = apply
    exports.inject = inject
    /* 供 scripts/pet-test.mjs 直接验证纯逻辑 */
    exports.__internals = {
      decide: decide,
      readSelection: readSelection,
      tierForSelection: tierForSelection,
      LIANG_TIERS: LIANG_TIERS,
      /* 预览页（scripts/preview.mjs）用它直接驱动状态，不在生产路径上调用 */
      preview: {
        publish: publish,
        getState: getState,
        paint: paint,
        build: buildOverlay,
        bridge: Bridge,
        selectionFromProjection: selectionFromProjection,
        tierOf: tierOf,
      },
    }
    return module.exports
  },
})
