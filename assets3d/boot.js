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

  const scene = new THREE.Scene()
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
  let armTop = null
  let armMid = null
  let armWrist = null
  let working = false
  let disposed = false
  let raf = 0
  let t0 = performance.now()
  let active = true
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
    scene.add(obj)
    objRoot = obj
    obj.updateMatrixWorld(true)

    /* ── 关节（按参考图逐处核对轴向）─────────────────────────────────
       参考图里三个红圈对应的轴向并不相同：
         J1 头顶下方（颈部圆柱的水平缝）：红弧绕水平缝一圈 → 绕【垂直 Y 轴】偏航
         J2 前臂顶端（前臂圆柱的水平缝）：同样是水平缝 → 绕【垂直 Y 轴】偏航
         J3 腕部（机身右侧、面向镜头的圆面）：红圈是画面内的整圆 → 绕【朝向镜头的 Z 轴】
       零件按 y 分布：横梁 79.9~93.4 / 上臂 60.6~79.9 / 前臂 25.0~60.6 / 手 4.3~25.0。
       层级：obj → p1(J1,Y) → p2(J2,Y) → p3(J3,Z) → 手 + 机身。 */
    {
      const arm = obj.getObjectByName('Moss_arm')
      const J1 = 79.9
      const J2 = 60.6
      const J3 = 25.0
      if (arm) {
        const geo = arm.geometry
        const posAttr = geo.attributes.position
        const norAttr = geo.attributes.normal
        const uvAttr = geo.attributes.uv
        const total = posAttr.count
        const M = arm.matrix.clone()
        const parent = arm.parent

        /* 焊接 + 连通块 */
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
          bucketOf.set(r, mid > J1 ? 0 : mid > J2 ? 1 : mid > J3 ? 2 : 3)
        })
        const buckets = [[], [], [], []]
        for (let i = 0; i < total; i += 3) buckets[bucketOf.get(find(wid[i]))].push(i)

        const buildSub = (triStarts) => {
          const count = triStarts.length * 3
          const p2 = new Float32Array(count * 3)
          const n2 = new Float32Array(count * 3)
          const u2 = uvAttr ? new Float32Array(count * 2) : null
          let w = 0
          for (const start of triStarts) {
            for (let k = 0; k < 3; k += 1) {
              const idx = start + k
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

        /* 所有分段先挂到 obj 下，保证 attach 时世界矩阵正确 */
        const makePart = (triStarts) => {
          const m = new THREE.Mesh(buildSub(triStarts), arm.material)
          m.frustumCulled = false
          m.matrixAutoUpdate = false
          m.matrix.copy(arm.matrix)
          parent.add(m)
          m.updateMatrixWorld(true)
          return m
        }
        const jointPos = (y) => {
          let sx = 0; let sz = 0; let n = 0
          for (let i = 0; i < total; i += 1) {
            tmp.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(M)
            if (Math.abs(tmp.y - y) < 3) { sx += tmp.x; sz += tmp.z; n += 1 }
          }
          return new THREE.Vector3(n ? sx / n : 0, y, n ? sz / n : 0)
        }

        const headMesh = makePart(buckets[0])
        const upperMesh = makePart(buckets[1])
        const foreMesh = makePart(buckets[2])
        const handMesh = makePart(buckets[3])

        const P1 = jointPos(J1)
        const P2 = jointPos(J2)
        const P3 = jointPos(J3)

        /* 嵌套枢轴：p1 → p2 → p3，起始无旋转，所以位置直接用差值 */
        const p1 = new THREE.Group(); p1.position.copy(P1); parent.add(p1); parent.updateMatrixWorld(true)
        p1.attach(upperMesh)

        const p2 = new THREE.Group(); p2.position.copy(P2).sub(P1); p1.add(p2); p1.updateMatrixWorld(true)
        p2.attach(foreMesh)

        const p3 = new THREE.Group(); p3.position.copy(P3).sub(P2); p2.add(p3); p2.updateMatrixWorld(true)
        p3.attach(handMesh)
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
    camera.position.set(focusX, 0, dist)
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
    /* 三个关节：按关键帧走具体角度（单位：度）
         J1/J2 绕垂直 Y 轴偏航，J3 绕朝向镜头的 Z 轴摆。
         序列：静止 → 右偏 → 左偏 → 回中 → 静止，每段 1.6s，平滑缓动。 */
      const POSES = [
        { a1: 0, a2: 0, a3: 0 },
        { a1: 9, a2: -5, a3: 6 },
        { a1: -7, a2: 6, a3: -5 },
        { a1: 4, a2: -2, a3: 3 },
        { a1: 0, a2: 0, a3: 0 },
      ]
      const SEG = working ? 1.0 : 1.6
      const amp = working ? 1.25 : 1
      const total = SEG * (POSES.length - 1)
      const lt = (t * speed) % total
      const i = Math.min(POSES.length - 2, Math.floor(lt / SEG))
      const f = (lt - i * SEG) / SEG
      const e = f * f * (3 - 2 * f) /* smoothstep */
      const from = POSES[i]
      const to = POSES[i + 1]
      const ang = (k) => ((from[k] + (to[k] - from[k]) * e) * amp) * Math.PI / 180
      if (armTop) armTop.rotation.y = ang('a1')
      if (armMid) armMid.rotation.y = ang('a2')
      if (armWrist) armWrist.rotation.z = ang('a3')
    renderer.render(scene, camera)
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
