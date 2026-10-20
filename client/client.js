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
    var ASSET_V = '3'
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
    function decide(input) {
      var selection = readSelection(input && input.modelState)
      var provider = selection ? selection.provider : ''
      var isDeepSeek = /deepseek/i.test(provider)
      var running = !!(input && input.running)
      var tier = tierForSelection(selection)
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
        asset: 'moss-idle.webp',
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

    /** 人民币金额的可读格式：小额保留 4 位，大额两位。 */
    function formatCny(value) {
      var n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (n === 0) return '¥0'
      if (n < 0.01) return '¥' + n.toFixed(5)
      if (n < 1) return '¥' + n.toFixed(4)
      return '¥' + n.toFixed(2)
    }

    function formatTokens(value) {
      var n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }

    /** 接口返回 → 弹层行；缺数据显示占位，不伪造数字。 */
    function costLines(payload) {
      if (!payload || payload.ok !== true) {
        return {
          ok: false,
          rows: [],
          note: (payload && payload.hint) || '暂时取不到用量（会话还没产生 token，或宿主未暴露用量投影）。',
          total: '—',
        }
      }
      var tokens = payload.tokens || {}
      var cost = payload.cost || {}
      var parts = cost.parts || {}
      return {
        ok: true,
        total: formatCny(cost.cny),
        rows: [
          { key: '缓存命中', tokens: formatTokens(tokens.cacheHit), cny: formatCny(parts.cacheHit) },
          { key: '输入（未命中）', tokens: formatTokens(Math.max(0, (tokens.input || 0) - (tokens.cacheHit || 0))), cny: formatCny(parts.input) },
          { key: '输出', tokens: formatTokens(tokens.output), cny: formatCny(parts.output) },
        ],
        note:
          (payload.cost && payload.cost.label ? payload.cost.label + ' · ' : '') +
          (payload.peak ? payload.peak.label : '') +
          ' · 价目 CNY/1M',
        source: payload.source || '',
      }
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
      '#' + ROOT_ID + '{position:fixed;right:18px;bottom:96px;width:196px;z-index:2147483000;',
      'font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#e8edf5);',
      'user-select:none;-webkit-user-select:none;pointer-events:auto;}',
      '#' + ROOT_ID + '{touch-action:none;}',
      '#' + ROOT_ID + ' .dpl-stage{position:relative;width:196px;height:228px;display:flex;align-items:flex-end;justify-content:center;cursor:grab;}',
      '#' + ROOT_ID + '.is-dragging .dpl-stage{cursor:grabbing;}',
      '#' + ROOT_ID + '.is-dragging .dpl-figure{animation-play-state:paused;}',
      '#' + ROOT_ID + ' .dpl-aura{position:absolute;left:50%;bottom:26px;width:190px;height:150px;transform:translateX(-50%);',
      'filter:blur(18px);opacity:.55;border-radius:50%;transition:background .6s ease,opacity .6s ease;}',
      '#' + ROOT_ID + ' .dpl-base{position:absolute;left:50%;bottom:2px;width:186px;transform:translateX(-50%);opacity:.92;pointer-events:none;',
      '-webkit-mask-image:radial-gradient(ellipse 58% 64% at 50% 62%,#000 42%,rgba(0,0,0,.5) 68%,transparent 84%);',
      'mask-image:radial-gradient(ellipse 58% 64% at 50% 62%,#000 42%,rgba(0,0,0,.5) 68%,transparent 84%);}',
      '#' + ROOT_ID + ' .dpl-figure{position:relative;width:152px;margin-bottom:36px;mix-blend-mode:screen;',
      'animation:dpl-breathe 4.2s ease-in-out infinite;}',
                  '#' + ROOT_ID + '[data-working="1"] .dpl-figure{animation:dpl-breathe 1.9s ease-in-out infinite;}',
            /* 梁神：用 liang-intensity-calibrator 的原始人像，做成圆形投影徽章 */
      '#' + ROOT_ID + '[data-character="liang"] .dpl-figure{width:150px;height:150px;object-fit:cover;border-radius:50%;',
      'border:1px solid color-mix(in srgb,var(--dpl-aura) 52%,transparent);',
      'box-shadow:0 0 26px color-mix(in srgb,var(--dpl-aura) 34%,transparent),inset 0 0 34px rgba(0,0,0,.55);',
      '-webkit-mask-image:radial-gradient(circle at 50% 46%,#000 62%,rgba(0,0,0,.72) 78%,transparent 92%);',
      'mask-image:radial-gradient(circle at 50% 46%,#000 62%,rgba(0,0,0,.72) 78%,transparent 92%);}',
      '#' + ROOT_ID + '[data-character="liang"] .dpl-figure-wrap{position:relative;}',
      '#' + ROOT_ID + '[data-character="liang"] .dpl-scanlines{opacity:1;}',
      '#' + ROOT_ID + ' .dpl-scanlines{position:absolute;left:50%;bottom:42px;width:150px;height:150px;border-radius:50%;',
      'transform:translateX(-50%);pointer-events:none;opacity:0;transition:opacity .3s ease;',
      'background:repeating-linear-gradient(to bottom,rgba(120,220,255,.13) 0 1px,transparent 1px 3px);mix-blend-mode:screen;}',
'#' + ROOT_ID + ' .dpl-ring{position:absolute;left:50%;bottom:10px;width:158px;height:32px;transform:translateX(-50%);',
      'border-radius:50%;border:1px solid var(--dpl-aura);opacity:.28;pointer-events:none;}',
      '#' + ROOT_ID + '[data-working="1"] .dpl-ring{opacity:.75;animation:dpl-spin 3.4s linear infinite;}',
      '#' + ROOT_ID + ' .dpl-scan{position:absolute;left:50%;bottom:0;width:168px;height:186px;transform:translateX(-50%);',
      'overflow:hidden;pointer-events:none;opacity:0;border-radius:50%;}',
      '#' + ROOT_ID + ' .dpl-scan::after{content:"";position:absolute;left:0;width:100%;height:16px;filter:blur(4px);',
      'background:linear-gradient(to bottom,transparent,var(--dpl-aura),transparent);opacity:.42;',
      '-webkit-mask-image:linear-gradient(to right,transparent,#000 22%,#000 78%,transparent);',
      'mask-image:linear-gradient(to right,transparent,#000 22%,#000 78%,transparent);}',
      '#' + ROOT_ID + '.is-switching .dpl-scan{opacity:1;}',
      '#' + ROOT_ID + '.is-switching .dpl-scan::after{animation:dpl-sweep .78s ease-in-out;}',
      '#' + ROOT_ID + '.is-switching .dpl-figure{animation:dpl-swap .78s ease-in-out;}',
      '#' + ROOT_ID + '.is-switching .dpl-aura{animation:dpl-flash .78s ease-in-out;}',
      '#' + ROOT_ID + ' .dpl-hud{display:flex;align-items:center;gap:6px;justify-content:center;margin-top:2px;',
      'font-size:11px;letter-spacing:.04em;}',
      '#' + ROOT_ID + ' .dpl-name{font-weight:650;color:var(--dpl-aura);text-shadow:0 0 10px color-mix(in srgb,var(--dpl-aura) 60%,transparent);}',
      '#' + ROOT_ID + ' .dpl-state{opacity:.72;}',
      '#' + ROOT_ID + ' .dpl-dot{width:5px;height:5px;border-radius:50%;background:var(--dpl-aura);opacity:.8;}',
      '#' + ROOT_ID + '[data-working="1"] .dpl-dot{animation:dpl-blink 1.1s ease-in-out infinite;}',
      '#' + ROOT_ID + ' .dpl-cost{position:absolute;right:0;bottom:calc(100% - 10px);width:236px;padding:12px 13px;',
      'border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#0d1117) 92%,transparent);',
      'border:1px solid color-mix(in srgb,var(--dpl-aura) 34%,transparent);',
      'box-shadow:0 14px 38px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.03) inset;',
      'backdrop-filter:blur(14px);font-size:11.5px;line-height:1.55;}',
      '#' + ROOT_ID + ' .dpl-cost[hidden]{display:none;}',
      '#' + ROOT_ID + ' .dpl-cost-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;}',
      '#' + ROOT_ID + ' .dpl-cost-total{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dpl-aura);}',
      '#' + ROOT_ID + ' .dpl-cost-row{display:flex;justify-content:space-between;gap:8px;opacity:.86;}',
      '#' + ROOT_ID + ' .dpl-cost-row span:last-child{font-variant-numeric:tabular-nums;}',
      '#' + ROOT_ID + ' .dpl-cost-note{margin-top:8px;padding-top:7px;border-top:1px dashed color-mix(in srgb,var(--dpl-aura) 22%,transparent);',
      'opacity:.6;font-size:10.5px;line-height:1.5;}',
      '@keyframes dpl-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
      '@keyframes dpl-spin{0%,100%{transform:translateX(-50%) scaleX(1) scaleY(1);opacity:.55}50%{transform:translateX(-50%) scaleX(1.06) scaleY(1.18);opacity:.95}}',
      '@keyframes dpl-blink{0%,100%{opacity:.25}50%{opacity:1}}',
      '@keyframes dpl-sweep{0%{top:-24px}100%{top:200px}}',
      '@keyframes dpl-swap{0%{opacity:1;transform:translateY(0) scale(1);filter:blur(0)}35%{opacity:.18;transform:translateY(-4px) scale(1.07);filter:blur(3px)}',
      '62%{opacity:0;transform:translateY(6px) scale(.93);filter:blur(6px)}100%{opacity:1;transform:translateY(0) scale(1);filter:blur(0)}}',
      '@keyframes dpl-flash{0%,100%{opacity:.55}46%{opacity:1;filter:blur(26px)}}',
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
    var costOpen = false
    var costPayload = null
    var costLoading = false

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

    function buildOverlay() {
      ensureStyle()
      var existing = document.getElementById(ROOT_ID)
      if (existing) return existing

      var root = el('div')
      root.id = ROOT_ID
      root.setAttribute('data-character', 'moss')
      root.setAttribute('data-working', '0')

      var stage = el('div', 'dpl-stage')
      var aura = el('div', 'dpl-aura')
      var base = el('img', 'dpl-base')
      base.src = assetUrl('holo-pedestal.webp')
      base.alt = ''
      base.draggable = false
      var figure = el('img', 'dpl-figure')
      figure.src = assetUrl('moss-idle.webp')
      figure.alt = ''
      figure.draggable = false
      figure.setAttribute('data-asset', 'moss-idle.webp')
      figure.setAttribute('data-char', 'moss')
      var scanlines = el('div', 'dpl-scanlines')
      var scan = el('div', 'dpl-scan')
      var ring = el('div', 'dpl-ring')
      stage.appendChild(aura)
      stage.appendChild(base)
      stage.appendChild(figure)
      stage.appendChild(scanlines)
      stage.appendChild(scan)
      stage.appendChild(ring)

      var hud = el('div', 'dpl-hud')
      var dot = el('span', 'dpl-dot')
      var nameNode = el('span', 'dpl-name', 'MOSS')
      var stateNode = el('span', 'dpl-state', '空闲')
      hud.appendChild(dot)
      hud.appendChild(nameNode)
      hud.appendChild(stateNode)

      var cost = el('div', 'dpl-cost')
      cost.hidden = true

      root.appendChild(cost)
      root.appendChild(stage)
      root.appendChild(hud)

      /* 点击判定放在 root 上：pointer capture 会把 click 重定向到捕获元素，
         挂在 stage 上会收不到。费用卡内部点击不触发开关。 */
      root.addEventListener('click', function (event) {
        event.stopPropagation()
        if (suppressClick) return
        if (event.target && event.target.closest && event.target.closest('.dpl-cost')) return
        void toggleCost()
      })
      document.addEventListener('click', function () {
        if (costOpen) closeCost()
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

      var figure = overlay.querySelector('.dpl-figure')
      var nameNode = overlay.querySelector('.dpl-name')
      var stateNode = overlay.querySelector('.dpl-state')
      var aura = overlay.querySelector('.dpl-aura')

      if (nameNode) nameNode.textContent = state.title
      if (stateNode) stateNode.textContent = state.subtitle
      if (aura) aura.style.background = 'radial-gradient(circle,' + state.aura + ' 0%, transparent 68%)'
      if (aura) aura.style.opacity = String(0.3 + state.glow * 0.55)

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

    function costMarkup() {
      if (!overlay) return
      var box = overlay.querySelector('.dpl-cost')
      if (!box) return
      while (box.firstChild) box.removeChild(box.firstChild)

      var lines = costLines(costPayload)
      var head = el('div', 'dpl-cost-head')
      var left = el('div')
      left.appendChild(el('div', '', current.modelLabel || current.model || '当前会话'))
      left.style.fontWeight = '600'
      left.style.opacity = '0.9'
      var total = el('div', 'dpl-cost-total', lines.total)
      head.appendChild(left)
      head.appendChild(total)
      box.appendChild(head)

      if (!lines.ok) {
        box.appendChild(el('div', 'dpl-cost-note', lines.note))
        return
      }
      lines.rows.forEach(function (row) {
        var line = el('div', 'dpl-cost-row')
        line.appendChild(el('span', '', row.key + '  ' + row.tokens))
        line.appendChild(el('span', '', row.cny))
        box.appendChild(line)
      })
      box.appendChild(el('div', 'dpl-cost-note', lines.note))
    }

    async function toggleCost() {
      if (costOpen) return closeCost()
      if (!overlay) return
      costOpen = true
      var box = overlay.querySelector('.dpl-cost')
      box.hidden = false
      if (!costPayload) {
        box.textContent = '正在结算…'
      }
      var query = new URLSearchParams()
      if (current.sessionId) query.set('sessionId', current.sessionId)
      if (current.model) query.set('model', current.model)
      if (current.provider) query.set('provider', current.provider)
      try {
        var response = await fetch(BASE + '/api/cost?' + query.toString(), { headers: { Accept: 'application/json' } })
        costPayload = await response.json()
      } catch (err) {
        costPayload = { ok: false, hint: '费用接口不可达：' + String((err && err.message) || err) }
      }
      if (!costOpen) return
      costMarkup()
    }

    function closeCost() {
      if (!overlay) return
      var box = overlay.querySelector('.dpl-cost')
      if (box) box.hidden = true
      costOpen = false
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
      var ctx = props.ctx

      var running = false
      if (useSessionStatus) {
        running = useSessionStatus(function (map) {
          if (!map || typeof map.get !== 'function') return false
          var row = map.get(sessionId)
          return !!(row && row.running === true)
        })
      }
      var modelState = useModelState(ctx, sessionId)

      var decision = useMemo(function () {
        return decide({ sessionId: sessionId, running: running, modelState: modelState })
      }, [sessionId, running, modelState])

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

    var inject = ['slots']

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
      subscribe(function (state) {
        paint(state, true)
      })

      if (!slots || typeof slots.inject !== 'function' || !h) return

      try {
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-pet-liang-bridge',
              order: 99,
            },
            function PetBridge(props) {
              return h(Bridge, { ctx: ctx, sessionId: props.sessionId, useSessionStatus: props.useSessionStatus })
            },
          )
        })
      } catch (e) {
        /* 该座位不存在时桌宠仍显示默认形态 */
      }
    }

    exports.apply = apply
    exports.inject = inject
    /* 供 scripts/pet-test.mjs 直接验证纯逻辑 */
    exports.__internals = {
      decide: decide,
      readSelection: readSelection,
      tierForSelection: tierForSelection,
      costLines: costLines,
      formatCny: formatCny,
      LIANG_TIERS: LIANG_TIERS,
      /* 预览页（scripts/preview.mjs）用它直接驱动状态，不在生产路径上调用 */
      preview: {
        publish: publish,
        getState: getState,
        paint: paint,
        build: buildOverlay,
      },
    }
    return module.exports
  },
})
