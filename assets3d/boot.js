/* MOSS 3D 渲染器：真实模型 + 关节旋转（绕肩部关节） */
import * as THREE from './three.module.min.js'
import { FBXLoader } from './FBXLoader.js'

const KEY = { Moss_Main: 'Main', Moss_arm: 'arm', Moss_Glass: 'Glass', Moss_Annexes: 'Annexes' }
const HAVE = new Set(['Main_base', 'Main_normal', 'Main_emissive', 'Main_orm', 'arm_base', 'arm_normal', 'arm_orm', 'Glass_base', 'Glass_orm', 'Annexes_base', 'Annexes_normal', 'Annexes_emissive', 'Annexes_orm'])

export function createMoss3D(canvas, opts) {
  const base = opts && opts.base ? opts.base : ''
  const ver = opts && opts.ver ? String(opts.ver) : ''
  const url = (p) => base + p + (ver ? '?v=' + ver : '')
  const onError = (opts && opts.onError) || function () {}
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15

  const scene = new THREE.Scene()
  /* 环境反射：金属件没有环境贴图会发平、看着不像 3D */
  try {
    const env = new THREE.PMREMGenerator(renderer)
    const room = new THREE.Scene()
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshBasicMaterial({ color: 0x8899aa, side: THREE.BackSide })
    room.add(new THREE.Mesh(geo, mat))
    const light = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    light.position.set(0, 2, 0); light.rotation.x = -Math.PI / 2
    room.add(light)
    scene.environment = env.fromScene(room, 0.04).texture
  } catch (e) { /* 环境贴图失败不影响主渲染 */ }
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 4000)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x24303d, 1.7))
  const key = new THREE.DirectionalLight(0xffffff, 2.5); key.position.set(50, 80, 90); scene.add(key)
  const fill = new THREE.DirectionalLight(0x9dc6ff, 1.2); fill.position.set(-70, 24, -30); scene.add(fill)
  const rim = new THREE.DirectionalLight(0xffd9a0, 0.9); rim.position.set(-20, -50, 40); scene.add(rim)

  const loader = new THREE.TextureLoader()
  const texS = (n) => { const t = loader.load(url('tex/' + n + '.webp')); t.colorSpace = THREE.SRGBColorSpace; return t }
  const texL = (n) => loader.load(url('tex/' + n + '.webp'))

  let pivot = null
  let objRoot = null
  let lensCore = null
  let lensHalo = null
  let lensLamp = null
  let eyeCore = null
  let eyeHalo = null
  let armTop = null
  let armMid = null
  let armWrist = null
  let working = false
  let disposed = false
  let raf = 0
  let t0 = performance.now()
  let active = true
  let healthChecked = false
  let baseY = 0
  const jointsDisabled = !!(opts && opts.joints === false)
  const motionAmp = (opts && typeof opts.motionAmp === 'number') ? opts.motionAmp : 1
  let last = 0

  function resize() {
    const w = canvas.clientWidth || 176
    const h = canvas.clientHeight || 196
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  new FBXLoader().load(url('moss.fbx'), (obj) => {
    obj.traverse((n) => {
      if (!n.isMesh) return
      const k = KEY[n.material.name] || 'Main'
      const orm = HAVE.has(k + '_orm') ? texL(k + '_orm') : null
      const mat = new THREE.MeshStandardMaterial({
        map: HAVE.has(k + '_base') ? texS(k + '_base') : null,
        metalnessMap: orm, roughnessMap: orm, aoMap: orm,
        metalness: 0.3, roughness: 0.62,
        transparent: k === 'Glass', opacity: k === 'Glass' ? 0.45 : 1,
      })
      if (HAVE.has(k + '_normal')) mat.normalMap = texL(k + '_normal')
      if (HAVE.has(k + '_emissive')) {
        mat.emissive = new THREE.Color(0xffffff)
        mat.emissiveIntensity = 1.3
        mat.emissiveMap = texL(k + '_emissive')
      }
      n.material = mat
    })

    const box = new THREE.Box3().setFromObject(obj)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    obj.position.sub(center)
    baseY = obj.position.y
    scene.add(obj)
    objRoot = obj
    obj.updateMatrixWorld(true)

    /* ── 三个关节（轴向由用户确认）──────────────────────
       J1 颈部：垂直轴 → 左右偏航，带整条手臂
       J2 肘部：垂直轴 → 左右偏航，带前臂+手块+机身
       J3 手腕：水平轴 → 前后点头，只带机身
       分段按网格零件 y 分布：>79.9 固定 / 60.6~79.9 上臂 / 25~60.6 前臂+手块 / <25 手块余部
       枢轴用拟合圆圆心，不用截面质心。 */
    if (!(typeof window !== 'undefined' && window.__noSplit__)) {
      const arm = obj.getObjectByName('Moss_arm')
      if (arm) {
        const geo = arm.geometry
        const posAttr = geo.attributes.position
        const norAttr = geo.attributes.normal
        const uvAttr = geo.attributes.uv
        const total = posAttr.count
        const M = arm.matrix.clone()
        const parent = arm.parent
        const weld = new Map()
        const wid = new Int32Array(total)
        for (let i = 0; i < total; i += 1) {
          const k = posAttr.getX(i).toFixed(2) + ',' + posAttr.getY(i).toFixed(2) + ',' + posAttr.getZ(i).toFixed(2)
          let id = weld.get(k)
          if (id === undefined) { id = weld.size; weld.set(k, id) }
          wid[i] = id
        }
        const par = new Int32Array(weld.size)
        for (let i = 0; i < par.length; i += 1) par[i] = i
        const find = (x) => { let r = x; while (par[r] !== r) r = par[r]; while (par[x] !== r) { const n = par[x]; par[x] = r; x = n } return r }
        const join = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) par[ra] = rb }
        for (let i = 0; i < total; i += 3) { join(wid[i], wid[i + 1]); join(wid[i], wid[i + 2]) }
        const tmp = new THREE.Vector3()
        const compY = new Map()
        for (let i = 0; i < total; i += 1) {
          const r = find(wid[i])
          tmp.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(M)
          const rec = compY.get(r)
          if (!rec) compY.set(r, { y0: tmp.y, y1: tmp.y })
          else { rec.y0 = Math.min(rec.y0, tmp.y); rec.y1 = Math.max(rec.y1, tmp.y) }
        }
        const bucketOf = new Map()
        compY.forEach((rec, r) => {
          const mid = (rec.y0 + rec.y1) / 2
          bucketOf.set(r, mid > 79.9 ? 0 : mid > 60.6 ? 1 : mid > 25.0 ? 2 : 3)
        })
        const buckets = [[], [], [], []]
        for (let i = 0; i < total; i += 3) buckets[bucketOf.get(find(wid[i]))].push(i)
        const buildSub = (tris) => {
          const cnt = tris.length * 3
          const p2 = new Float32Array(cnt * 3)
          const n2 = new Float32Array(cnt * 3)
          const u2 = uvAttr ? new Float32Array(cnt * 2) : null
          let w = 0
          for (const st of tris) {
            for (let k = 0; k < 3; k += 1) {
              const idx = st + k
              p2[w * 3] = posAttr.getX(idx); p2[w * 3 + 1] = posAttr.getY(idx); p2[w * 3 + 2] = posAttr.getZ(idx)
              if (norAttr) { n2[w * 3] = norAttr.getX(idx); n2[w * 3 + 1] = norAttr.getY(idx); n2[w * 3 + 2] = norAttr.getZ(idx) }
              if (u2) { u2[w * 2] = uvAttr.getX(idx); u2[w * 2 + 1] = uvAttr.getY(idx) }
              w += 1
            }
          }
          const g2 = new THREE.BufferGeometry()
          g2.setAttribute('position', new THREE.BufferAttribute(p2, 3))
          if (norAttr) g2.setAttribute('normal', new THREE.BufferAttribute(n2, 3))
          if (u2) g2.setAttribute('uv', new THREE.BufferAttribute(u2, 2))
          g2.computeBoundingSphere()
          return g2
        }
        const makePart = (tris) => {
          const m = new THREE.Mesh(buildSub(tris), arm.material)
          m.frustumCulled = false
          m.matrixAutoUpdate = false
          m.matrix.copy(arm.matrix)
          parent.add(m)
          m.updateMatrixWorld(true)
          return m
        }
        const headMesh = makePart(buckets[0])
        const upperMesh = makePart(buckets[1])
        const foreMesh = makePart(buckets[2])
        const handMesh = makePart(buckets[3])
        const P1 = new THREE.Vector3(-0.40, 79.90, 18.00)
        const P2 = new THREE.Vector3(32.90, 60.60, 18.00)
        const hb = new THREE.Box3().setFromObject(handMesh)
        const bodyMesh0 = obj.getObjectByName('Moss_Main')
        const bb0 = bodyMesh0 ? new THREE.Box3().setFromObject(bodyMesh0) : hb
        /* J3 轴心：手块凸台是沿 X 轴的圆柱（拟合 r=6.59 残差 20.6%，
           绕垂直轴拟合残差 52.3% —— 所以 J3 必须是水平 X 轴，即点头） */
        const P3 = new THREE.Vector3(19.0, 13.57, 18.04)
        const p1 = new THREE.Group(); p1.position.copy(P1); parent.add(p1); parent.updateMatrixWorld(true)
        p1.attach(upperMesh)
        const p2 = new THREE.Group(); p2.position.copy(P2).sub(P1); p1.add(p2); p1.updateMatrixWorld(true)
        p2.attach(foreMesh)
        p2.attach(handMesh)
        /* 机身的枢轴必须挂在 J2 下：手臂摆动时机身才会跟着走 */
        const p3 = new THREE.Group(); p3.position.copy(P3).sub(P2); p2.add(p3); p2.updateMatrixWorld(true)
        ;['Moss_Main', 'Moss_Annexes', 'Moss_Glass'].forEach((nm) => {
          const part = obj.getObjectByName(nm)
          if (part) p3.attach(part)
        })
        arm.visible = false
        armTop = p1
        armMid = p2
        armWrist = p3
      }
    }

    /* 红眼：模型自带发光贴图只有 3 个 LED 点，主镜头没做发光，这里补一层 */
    const mainMesh = obj.getObjectByName('Moss_Main')
    if (mainMesh) {
      const mb = new THREE.Box3().setFromObject(mainMesh)
      const ms = mb.getSize(new THREE.Vector3())
      const mc = mb.getCenter(new THREE.Vector3())
      /* 镜头在机身正面中心偏左上（按渲染结果标定） */
      const lensPos = new THREE.Vector3(
        mc.x + ms.x * 0.105,
        mc.y + ms.y * 0.142,
        mb.max.z + ms.z * 0.02,
      )
      const radius = Math.min(ms.x, ms.y) * 0.105

      const core = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 32),
        new THREE.MeshBasicMaterial({
          color: 0xff4a22, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      )
      core.position.copy(obj.worldToLocal(lensPos.clone()))
      core.renderOrder = 5
      obj.add(core)

      /* 柔光晕：径向渐变贴图 */
      const cvs = document.createElement('canvas')
      cvs.width = cvs.height = 128
      const ctx = cvs.getContext('2d')
      const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64)
      g.addColorStop(0, 'rgba(255,120,60,0.95)')
      g.addColorStop(0.35, 'rgba(255,70,30,0.45)')
      g.addColorStop(1, 'rgba(255,40,20,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 128, 128)
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(cvs), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9,
      }))
      halo.position.copy(lensPos).add(new THREE.Vector3(0, 0, ms.z * 0.01))
      halo.scale.setScalar(radius * 10)
      halo.userData.base = radius * 10
      halo.renderOrder = 6
      scene.add(halo)
      const lensLight = new THREE.PointLight(0xff3a14, working ? 3.2 : 1.5, ms.y * 0.9, 2)
      lensLight.position.copy(obj.worldToLocal(lensPos.clone())).add(new THREE.Vector3(0, 0, ms.z * 0.35))
      obj.add(lensLight)
      lensCore = core
      lensHalo = halo
      lensLamp = lensLight
      eyeCore = core
      eyeHalo = halo
    }

    /* 以机身（Moss_Main）为视觉中心，竖向撑满画布 */
    const main = obj.getObjectByName('Moss_Main')
    let focusX = 0
    if (main) {
      const mb = new THREE.Box3().setFromObject(main)
      focusX = mb.getCenter(new THREE.Vector3()).x
    }
    const fovRad = (camera.fov * Math.PI) / 180
    const dist = (size.y / 2) / Math.tan(fovRad / 2) * 1.16
    /* 3/4 视角：正对时绕垂直轴的偏航会变成「往屏幕里外摆」，看不出来 */
    const AZ = 26 * Math.PI / 180
    camera.position.set(focusX + Math.sin(AZ) * dist, size.y * 0.06, Math.cos(AZ) * dist)
    camera.lookAt(focusX, 0, 0)
    resize()
    loop()
  }, undefined, (err) => {
    onError(err instanceof Error ? err : new Error('fbx load failed'))
  })

  function loop(now) {
    if (disposed) return
    raf = requestAnimationFrame(loop)
    if (!active) return
    /* 30fps 上限，桌宠不需要 60fps */
    if (now && now - last < 33) return
    last = now || 0
    const t = (performance.now() - t0) / 1000
    const speed = working ? 2.6 : 1
    /* ── 动作脚本 ─────────────────────────────────────
       两个模式各有一组「动作段」，按顺序循环；每段描述 a1/a2/a3 角度与红眼亮度。
       空闲：小幅、慢、像在看人或思考
       执行：大幅、快、带停顿的机械感，多个动作段轮流执行 */
    const IDLE = [
      /* 1 缓慢环视：先看右、停一会、再看左、回正 */
      { name: '缓慢环视', dur: 30, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.40 },
        { t: 7, a1: 6, a2: -2.5, a3: 1.6, eye: 0.52 },
        { t: 13, a1: 6, a2: -2.5, a3: 1.6, eye: 0.46 },
        { t: 19, a1: -5, a2: 2, a3: -1.4, eye: 0.50 },
        { t: 25, a1: -5, a2: 2, a3: -1.4, eye: 0.44 },
        { t: 30, a1: 0, a2: 0, a3: 0, eye: 0.40 },
      ] },
      /* 2 轻微侧望：偏向一侧并停留，像在留意什么 */
      { name: '轻微侧望', dur: 30, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.42 },
        { t: 9, a1: -4.5, a2: 1.8, a3: -2.2, eye: 0.48 },
        { t: 21, a1: -4.5, a2: 1.8, a3: -2.4, eye: 0.44 },
        { t: 30, a1: 0, a2: 0, a3: 0, eye: 0.42 },
      ] },
      /* 3 沉思：低头、长停、眼缓慢亮起再落 */
      { name: '沉思', dur: 30, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.40 },
        { t: 6, a1: 1.5, a2: -0.8, a3: -3.2, eye: 0.72 },
        { t: 16, a1: 1.8, a2: -1, a3: -3.0, eye: 0.58 },
        { t: 23, a1: 1.2, a2: -0.6, a3: -2.4, eye: 0.66 },
        { t: 30, a1: 0, a2: 0, a3: 0, eye: 0.40 },
      ] },
      /* 4 巡视：左右各看一次，中间各停一段 */
      { name: '巡视', dur: 30, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.42 },
        { t: 6, a1: 5.5, a2: -2.2, a3: 1.2, eye: 0.55 },
        { t: 11, a1: 5.5, a2: -2.2, a3: 1.2, eye: 0.45 },
        { t: 17, a1: -5.5, a2: 2.2, a3: -1.2, eye: 0.55 },
        { t: 22, a1: -5.5, a2: 2.2, a3: -1.2, eye: 0.45 },
        { t: 30, a1: 0, a2: 0, a3: 0, eye: 0.42 },
      ] },
      /* 5 静止休整：几乎不动，只有极小的姿态漂移 */
      { name: '静止休整', dur: 30, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.38 },
        { t: 10, a1: 1.2, a2: -0.5, a3: 0.8, eye: 0.44 },
        { t: 20, a1: 0.6, a2: -0.2, a3: -0.6, eye: 0.40 },
        { t: 30, a1: 0, a2: 0, a3: 0, eye: 0.38 },
      ] },
    ]

    const WORK = [
      /* 1 扫视巡检：左右大范围巡视，转向瞬间眼亮 */
      { name: '扫视巡检', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.70 },
        { t: 3.5, a1: -20, a2: 9, a3: -3, eye: 1.00 },
        { t: 6.5, a1: -20, a2: 9, a3: -3, eye: 0.60 },
        { t: 10, a1: 20, a2: -9, a3: 4, eye: 1.00 },
        { t: 13.5, a1: 20, a2: -9, a3: 4, eye: 0.60 },
        { t: 16.5, a1: 6, a2: -3, a3: 1, eye: 0.85 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.70 },
      ] },
      /* 2 点头确认：三次点头，每次闪一下 */
      { name: '点头确认', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.70 },
        { t: 2, a1: 0, a2: 0, a3: 10, eye: 1.05 },
        { t: 3, a1: 0, a2: 0, a3: -3, eye: 0.50 },
        { t: 5, a1: 0, a2: 0, a3: 10, eye: 1.05 },
        { t: 6, a1: 0, a2: 0, a3: -3, eye: 0.50 },
        { t: 8, a1: 0, a2: 0, a3: 10, eye: 1.05 },
        { t: 9.2, a1: 0, a2: 0, a3: -3, eye: 0.50 },
        { t: 13, a1: 7, a2: -3, a3: 3, eye: 0.85 },
        { t: 17, a1: -4, a2: 2, a3: -1, eye: 0.75 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.70 },
      ] },
      /* 3 分步转向：走一步、停一下，机械感 */
      { name: '分步转向', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.72 },
        { t: 1.8, a1: 24, a2: -10, a3: 0, eye: 1.00 },
        { t: 6.5, a1: 24, a2: -10, a3: 0, eye: 0.58 },
        { t: 8.2, a1: 24, a2: -10, a3: -7, eye: 0.95 },
        { t: 13, a1: 24, a2: -10, a3: -7, eye: 0.55 },
        { t: 15, a1: -18, a2: 8, a3: 3, eye: 1.00 },
        { t: 17.2, a1: -18, a2: 8, a3: 3, eye: 0.65 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.72 },
      ] },
      /* 4 快扫：高频小幅摆动五次 */
      { name: '快扫', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.75 },
        { t: 1.2, a1: 11, a2: -5, a3: 3, eye: 1.10 },
        { t: 2.4, a1: -11, a2: 5, a3: -3, eye: 0.65 },
        { t: 3.6, a1: 11, a2: -5, a3: 3, eye: 1.10 },
        { t: 4.8, a1: -11, a2: 5, a3: -3, eye: 0.65 },
        { t: 6, a1: 11, a2: -5, a3: 3, eye: 1.10 },
        { t: 8, a1: 0, a2: 0, a3: 0, eye: 0.70 },
        { t: 12, a1: -8, a2: 4, a3: -2, eye: 0.95 },
        { t: 16, a1: 8, a2: -4, a3: 2, eye: 0.95 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.70 },
      ] },
      /* 5 抬头检查：抬起来看，停住，再放回 */
      { name: '抬头检查', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.70 },
        { t: 3, a1: 4, a2: -2, a3: 12, eye: 1.00 },
        { t: 8, a1: 4, a2: -2, a3: 12, eye: 0.62 },
        { t: 11, a1: -6, a2: 3, a3: -8, eye: 0.95 },
        { t: 15, a1: -6, a2: 3, a3: -8, eye: 0.60 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.70 },
      ] },
      /* 6 深度思考：慢慢漂，长时间停住，眼缓慢起伏 */
      { name: '深度思考', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.55 },
        { t: 5, a1: 5, a2: -2, a3: -4, eye: 0.80 },
        { t: 12, a1: 6, a2: -3, a3: -4.5, eye: 0.62 },
        { t: 16, a1: -3, a2: 1.5, a3: 2, eye: 0.72 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.55 },
      ] },
      /* 7 锁定目标：扫一圈后锁定一点，久停，眼最亮 */
      { name: '锁定目标', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.72 },
        { t: 2.5, a1: -16, a2: 7, a3: 2, eye: 0.90 },
        { t: 5, a1: 14, a2: -6, a3: -2, eye: 0.90 },
        { t: 7.5, a1: 22, a2: -9, a3: 5, eye: 1.15 },
        { t: 13, a1: 22, a2: -9, a3: 5, eye: 0.95 },
        { t: 15.5, a1: 10, a2: -4, a3: 2, eye: 1.10 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.72 },
      ] },
      /* 8 反向复核：从另一侧再扫一遍 */
      { name: '反向复核', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.70 },
        { t: 4, a1: 17, a2: -8, a3: -3, eye: 0.95 },
        { t: 7, a1: 17, a2: -8, a3: -3, eye: 0.58 },
        { t: 11, a1: -17, a2: 8, a3: 3, eye: 0.95 },
        { t: 14, a1: -17, a2: 8, a3: 3, eye: 0.58 },
        { t: 17, a1: -6, a2: 3, a3: 1, eye: 0.85 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.70 },
      ] },
      /* 9 微动待机：几乎不动，只偶尔闪一下 */
      { name: '微动待机', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.45 },
        { t: 4, a1: 2.5, a2: -1, a3: 1.5, eye: 0.50 },
        { t: 8, a1: -2, a2: 1, a3: -1, eye: 1.05 },
        { t: 9, a1: -2, a2: 1, a3: -1, eye: 0.45 },
        { t: 14, a1: 1.5, a2: -0.6, a3: 0.8, eye: 0.52 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.45 },
      ] },
      /* 10 归位：收尾，轻点头后回正 */
      { name: '归位', dur: 20, keys: [
        { t: 0, a1: 0, a2: 0, a3: 0, eye: 0.70 },
        { t: 3, a1: 3, a2: -1.5, a3: 4, eye: 0.90 },
        { t: 6, a1: 3, a2: -1.5, a3: -2, eye: 0.60 },
        { t: 9, a1: 3, a2: -1.5, a3: 4, eye: 0.90 },
        { t: 13, a1: -2, a2: 1, a3: 0, eye: 0.65 },
        { t: 20, a1: 0, a2: 0, a3: 0, eye: 0.55 },
      ] },
    ]

    const mode = working ? WORK : IDLE
    const totalDur = mode.reduce((s2, m) => s2 + m.dur, 0)
    const tt = (t * speed) % totalDur
    let acc = 0
    let move = mode[mode.length - 1]
    for (const m of mode) {
      if (tt < acc + m.dur) { move = m; break }
      acc += m.dur
    }
    const mt = tt - acc
    const keys = move.keys
    let k = keys.length - 2
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (mt < keys[i + 1].t) { k = i; break }
    }
    const k0 = keys[k]
    const k1 = keys[Math.min(k + 1, keys.length - 1)]
    const span = Math.max(0.001, k1.t - k0.t)
    const f = Math.min(1, Math.max(0, (mt - k0.t) / span))
    /* 执行态用「走完再停」的机械缓动，空闲用柔和缓动 */
    const ease = working
      ? (f < 0.72 ? (f / 0.72) * (f / 0.72) * (3 - 2 * (f / 0.72)) : 1)
      : f * f * (3 - 2 * f)
    const mix = (key) => (k0[key] + (k1[key] - k0[key]) * ease)
    const frozen = (typeof window !== 'undefined' && window.__freeze__) || jointsDisabled
    /* 空闲态叠加极缓慢的微动（周期 60~110s），避免长时间保持一个姿态像卡住 */
    const micro = working ? 0 : 1
    const m1 = Math.sin((t / 87) * Math.PI * 2) * 0.55 * micro
    const m2 = Math.sin((t / 103) * Math.PI * 2 + 1.1) * 0.35 * micro
    const m3 = Math.sin((t / 71) * Math.PI * 2 + 2.3) * 0.45 * micro
    const A1 = frozen ? 0 : ((mix('a1') + m1) * motionAmp * Math.PI) / 180
    const A2 = frozen ? 0 : ((mix('a2') + m2) * motionAmp * Math.PI) / 180
    const A3 = frozen ? 0 : ((mix('a3') + m3) * motionAmp * Math.PI) / 180
    if (armTop) armTop.rotation.set(0, A1, 0)
    if (armMid) armMid.rotation.set(0, A2, 0)
    if (armWrist) armWrist.rotation.set(A3, 0, 0)

    /* 红眼：亮度来自脚本，另叠加极轻微呼吸，避免死板 */
    const eyeBase = frozen ? 0.45 : mix('eye')
    const breathe = 1 + Math.sin(t * 2.1 * speed) * 0.04
    const eye = Math.max(0, Math.min(1.3, eyeBase * breathe))
    if (eyeCore) eyeCore.material.opacity = 0.35 + eye * 0.55
    if (eyeHalo) {
      eyeHalo.material.opacity = 0.25 + eye * 0.7
      const sc = (eyeHalo.userData.base || 40) * (0.82 + eye * 0.25)
      eyeHalo.scale.setScalar(sc)
    }
    if (lensLamp) lensLamp.intensity = (working ? 2.2 : 1.1) * (0.45 + eye * 1.5)

    renderer.render(scene, camera)
    if (!healthChecked) {
      healthChecked = true
      window.setTimeout(() => {
        if (disposed) return
        if (renderer.info.render.calls === 0) {
          onError(new Error('3D 渲染无输出（calls=0）'))
        }
      }, 1200)
    }
  }

  return {
    setWorking(v) { working = !!v },
    setActive(v) {
      active = !!v
      if (active && !disposed) { t0 = performance.now() - 0 ; }
    },
    resize,
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      try { renderer.dispose() } catch (e) { /* noop */ }
    },
  }
}
