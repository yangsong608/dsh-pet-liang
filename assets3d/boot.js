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

    /* ── 机械臂拆分：模型的手臂是 52 个独立零件，按高度分成上臂 / 前臂 / 手 ──
       每段绕自己的关节旋转，段与段之间是真实关节，不会撕裂。 */
    const arm = obj.getObjectByName('Moss_arm')
    if (arm) {
      const geo = arm.geometry
      const posAttr = geo.attributes.position
      const norAttr = geo.attributes.normal
      const uvAttr = geo.attributes.uv
      const total = posAttr.count

      /* 1) 按坐标焊接后并查集，得到三角面所属的连通块 */
      const weld = new Map()
      const wid = new Int32Array(total)
      for (let i = 0; i < total; i += 1) {
        const k = posAttr.getX(i).toFixed(2) + ',' + posAttr.getY(i).toFixed(2) + ',' + posAttr.getZ(i).toFixed(2)
        let id = weld.get(k)
        if (id === undefined) { id = weld.size; weld.set(k, id) }
        wid[i] = id
      }
      const parent = new Int32Array(weld.size)
      for (let i = 0; i < parent.length; i += 1) parent[i] = i
      const find = (x) => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n } return r }
      const join = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb }
      for (let i = 0; i < total; i += 3) { join(wid[i], wid[i + 1]); join(wid[i], wid[i + 2]) }

      /* 2) 每个连通块的世界坐标 Y（手臂网格可能带旋转，必须转到世界） */
      arm.updateMatrixWorld(true)
      const root = arm.matrixWorld
      const toWorld = new THREE.Vector3()
      const compY = new Map()
      for (let i = 0; i < total; i += 1) {
        const r = find(wid[i])
        toWorld.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(root)
        const rec = compY.get(r)
        if (!rec) compY.set(r, { y0: toWorld.y, y1: toWorld.y, sum: toWorld.y, n: 1 })
        else { rec.y0 = Math.min(rec.y0, toWorld.y); rec.y1 = Math.max(rec.y1, toWorld.y); rec.sum += toWorld.y; rec.n += 1 }
      }
      let minY = Infinity; let maxY = -Infinity
      compY.forEach((rec) => { minY = Math.min(minY, rec.y0); maxY = Math.max(maxY, rec.y1) })
      const span = Math.max(0.001, maxY - minY)
      const yShoulder = maxY - span * 0.30
      const yElbow = maxY - span * 0.68

      /* 3) 按组的包围盒把三角面分到三段里 */
      const groupOf = new Map()   // componentRoot -> 0 上臂 / 1 前臂 / 2 手
      compY.forEach((rec, r) => {
        const mid = (rec.y0 + rec.y1) / 2
        groupOf.set(r, mid > yShoulder ? 0 : mid > yElbow ? 1 : 2)
      })

      const buckets = [[], [], []]
      for (let i = 0; i < total; i += 3) {
        const gI = groupOf.get(find(wid[i])) || 0
        buckets[gI].push(i)
      }

      const buildSub = (triStarts) => {
        const count = triStarts.length * 3
        const p2 = new Float32Array(count * 3)
        const n2 = new Float32Array(count * 3)
        const u2 = uvAttr ? new Float32Array(count * 2) : null
        let w = 0
        for (const start of triStarts) {
          for (let k = 0; k < 3; k += 1) {
            const v = start + k
            p2[w * 3] = posAttr.getX(v); p2[w * 3 + 1] = posAttr.getY(v); p2[w * 3 + 2] = posAttr.getZ(v)
            if (norAttr) { n2[w * 3] = norAttr.getX(v); n2[w * 3 + 1] = norAttr.getY(v); n2[w * 3 + 2] = norAttr.getZ(v) }
            if (u2) { u2[w * 2] = uvAttr.getX(v); u2[w * 2 + 1] = uvAttr.getY(v) }
            w += 1
          }
        }
        const g2 = new THREE.BufferGeometry()
        g2.setAttribute('position', new THREE.BufferAttribute(p2, 3))
        if (norAttr) g2.setAttribute('normal', new THREE.BufferAttribute(n2, 3))
        if (u2) g2.setAttribute('uv', new THREE.BufferAttribute(u2, 2))
        return g2
      }

      const parentOfArm = arm.parent
      const armMaterial = arm.material
      const makePivot = (worldPos, parentObj) => {
        const p = new THREE.Group()
        p.position.copy(parentObj.worldToLocal(worldPos.clone()))
        parentObj.add(p)
        parentObj.updateMatrixWorld(true)
        return p
      }
      const segWorld = [[], [], []]
      for (let i = 0; i < total; i += 1) {
        const gI = groupOf.get(find(wid[i])) || 0
        toWorld.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(root)
        segWorld[gI].push(toWorld.clone())
      }
      const topOf = (arr) => {
        if (!arr.length) return new THREE.Vector3()
        let top = -Infinity
        for (const v of arr) { if (v.y > top) top = v.y }
        let sx = 0; let sz = 0; let n = 0
        for (const v of arr) { if (v.y > top - span * 0.05) { sx += v.x; sz += v.z; n += 1 } }
        return new THREE.Vector3(sx / Math.max(1, n), top, sz / Math.max(1, n))
      }
      const elbowWorld = topOf(segWorld[1])
      const wristWorld = topOf(segWorld[2])

      const place = (triStarts) => {
        const mesh = new THREE.Mesh(buildSub(triStarts), armMaterial)
        mesh.matrix.copy(arm.matrix)
        mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale)
        return mesh
      }

      /* 头 + 上臂：刚性固定（它是整条臂的挂载端，不能转） */
      const fixed = place(buckets[0])
      parentOfArm.add(fixed)
      parentOfArm.updateMatrixWorld(true)
      fixed.matrix.copy(arm.matrix)
      fixed.matrix.decompose(fixed.position, fixed.quaternion, fixed.scale)

      /* 前臂：绕肘关节 */
      const elbow = makePivot(elbowWorld, parentOfArm)
      const fore = place(buckets[1])
      elbow.attach(fore)

      /* 手：绕腕关节，跟着肘一起动 */
      const wrist = makePivot(wristWorld, parentOfArm)
      const hand = place(buckets[2])
      wrist.attach(hand)

      arm.visible = false
      armTop = elbow
      armMid = wrist
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
    if (armTop) {
      /* 肩关节与肘关节反向配合：手臂抬起时小臂回折，手始终靠近机身 */
      const amp = working ? 6 : 4
      const s1 = Math.sin(t * 0.75 * speed) * (amp * Math.PI / 180)
      armTop.rotation.z = s1
      if (armMid) armMid.rotation.z = -s1 * 0.55
    }
    if (lensCore && lensHalo) {
      /* 空闲：暗红呼吸；执行：亮起并快速脉冲 */
      const base = working ? 0.95 : 0.55
      const k = working ? 0.45 : 0.18
      const pulse = base + Math.sin(t * (working ? 5.2 : 1.6)) * k
      lensCore.material.opacity = Math.max(0.15, Math.min(1, pulse))
      lensCore.material.color.setHex(working ? 0xff2a0c : 0xff5a2c)
      if (lensLamp) lensLamp.intensity = (working ? 3.4 : 1.4) * (0.85 + 0.15 * Math.sin(t * (working ? 5.2 : 1.6)))
      lensHalo.material.opacity = Math.max(0.12, Math.min(1, pulse * 0.85))
      lensHalo.scale.setScalar((lensHalo.userData.base || lensHalo.scale.x) * (1 + (working ? 0.06 : 0.03) * Math.sin(t * (working ? 5.2 : 1.6))))
    }
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
