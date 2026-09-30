import './style.css'
import {
  loadPotreeV2, loadPotreeV2FromFiles, PotreeV2Clipping, selectPotreeV2Files,
  type PotreeV2ClipBoxMode, type PotreeV2PickResult, type PotreeV2PointCloud, type PotreeV2PointShape,
  type PotreeV2PointSizeType,
} from '@geemil/potree-v2-three'
import GUI from 'lil-gui'
import {
  BoxGeometry, EdgesGeometry, Euler, LineBasicMaterial, LineSegments, Matrix4, PerspectiveCamera, Plane, Quaternion,
  Scene, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RenderProfiler } from './perf'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <div id="viewport"><div id="pick-marker" hidden></div></div>
  <div id="status" role="status">読み込み中…</div>
  <input id="files-input" type="file" accept=".json,.bin" multiple hidden>
`

const viewport = document.querySelector<HTMLDivElement>('#viewport')!
const filesInput = document.querySelector<HTMLInputElement>('#files-input')!
const status = document.querySelector<HTMLDivElement>('#status')!
const pickMarker = document.querySelector<HTMLDivElement>('#pick-marker')!

const settings = {
  url: new URLSearchParams(location.search).get('url') ?? '/pump/metadata.json',
  pointSize: 2,
  pointShape: 'square' as PotreeV2PointShape,
  pointSizeType: 'fixed' as PotreeV2PointSizeType,
  minPointSize: 2,
  maxPointSize: 50,
  pointBudgetMP: 2,
  minNodePixelSize: 30,
  maxNodesToGPUPerFrame: 8,
  showBoundingBoxes: false,
  hoverPick: true,
  pickRadius: 0,
  pixelRatio: Math.min(devicePixelRatio, 2),
  continuousRender: false,
}
const info = {
  source: '—',
  points: '—',
  encoding: '—',
  projection: '—',
  attributes: '—',
}
// Box centre and size are fractions of the cloud's bounding box; the plane offset too.
const clipSettings = {
  boxEnabled: false,
  boxMode: 'hide-inside' as PotreeV2ClipBoxMode,
  boxPrune: true,
  showBox: true,
  centerX: 0.5, centerY: 0.5, centerZ: 0.5,
  sizeX: 0.5, sizeY: 0.5, sizeZ: 0.5,
  rotationZ: 0,
  planeEnabled: false,
  planeAxis: 'z' as 'x' | 'y' | 'z',
  planeOffset: 0.5,
  planeFlip: false,
  planePrune: true,
}
const performanceStats = { fps: '—', frameMs: '—', cpuMs: '—', gpuMs: '—', drawCalls: '—', points: '—' }
const picked = { node: '—', index: '—', position: '—', attributes: '—' }
const fetchStats = { nodes: 0, requests: 0, average: '—' }
const timing = {
  state: '—', elapsed: '—', decodedReady: '—', sceneReady: '—',
  required: '—', pendingScene: '—', sceneConversions: '—',
  batches: '—', activeBatches: '—', lastBatch: '—', lastConversion: '—',
  hierarchy: '—', hierarchyMs: '—', fetchMs: '—', setupMs: '—',
  brotliMs: '—', attributesMs: '—', fetchedBytes: '—', throttled: '—', aborted: '—',
}
const actions = {
  loadUrl: () => {
    const url = settings.url.trim()
    if (!url) { setStatus('metadata.json の URL を入力してください。', true); return }
    void openCloud(() => loadPotreeV2(url, loadOptions()), url, url)
  },
  chooseFiles: () => filesInput.click(),
  clearFetchStats: () => {
    cloud?.clearFetchStats()
    updateFetchStats()
  },
  reload: () => {
    if (currentLoader) void openCloud(currentLoader, currentSource, currentUrl)
  },
  resetMeasurement: () => {
    cloud?.resetLoadDiagnostics()
    updateTiming()
  },
  copyMeasurement: () => {
    if (!cloud) return
    const result = {
      decoder: 'google/brotli WASM',
      source: currentSource,
      fetchStats: cloud.fetchStats,
      loadDiagnostics: cloud.loadDiagnostics,
    }
    void navigator.clipboard.writeText(JSON.stringify(result, null, 2)).catch(error => {
      setStatus(error instanceof Error ? error.message : String(error), true)
    })
  },
}

const gui = new GUI({ title: 'Potree v2 / Three.js', width: 340 })
const sourceFolder = gui.addFolder('読み込み')
sourceFolder.add(settings, 'url').name('metadata.json URL')
sourceFolder.add(actions, 'loadUrl').name('URL を読み込む')
sourceFolder.add(actions, 'chooseFiles').name('3ファイルを選択')
sourceFolder.add(actions, 'reload').name('同じデータを再読み込み')
const appearanceFolder = gui.addFolder('表示')
// `size` is pixels for fixed and a spacing factor otherwise, so each type keeps its own value.
const pointSizes: Record<PotreeV2PointSizeType, number> = { fixed: settings.pointSize, attenuated: 1, adaptive: 1 }
appearanceFolder.add(settings, 'pointSizeType', { 固定: 'fixed', 距離で減衰: 'attenuated', 適応: 'adaptive' }).name('点サイズの種類').onChange((value: PotreeV2PointSizeType) => {
  if (cloud) cloud.material.sizeType = value
  pointSizeController.setValue(pointSizes[value])
  requestRender()
})
const pointSizeController = appearanceFolder.add(settings, 'pointSize', 0.1, 8, 0.1).name('点のサイズ (px / 倍率)').onChange((value: number) => {
  pointSizes[settings.pointSizeType] = value
  if (cloud) cloud.material.size = value
  requestRender()
})
appearanceFolder.add(settings, 'minPointSize', 0, 20, 0.5).name('最小サイズ (px)').onChange((value: number) => {
  if (cloud) cloud.material.minSize = value
  requestRender()
})
appearanceFolder.add(settings, 'maxPointSize', 1, 100, 1).name('最大サイズ (px)').onChange((value: number) => {
  if (cloud) cloud.material.maxSize = value
  requestRender()
})
appearanceFolder.add(settings, 'pointShape', { 四角: 'square', 丸: 'circle' }).name('点の形').onChange((value: PotreeV2PointShape) => {
  if (cloud) cloud.material.shape = value
  requestRender()
})
appearanceFolder.add(settings, 'pointBudgetMP', 0.5, 20, 0.5).name('点数予算 (MP)').onChange((value: number) => {
  if (cloud) cloud.pointBudget = value * 1_000_000
})
appearanceFolder.add(settings, 'minNodePixelSize', 0, 1000, 1).name('最小ノード投影半径 (px)').onChange((value: number) => {
  if (cloud) cloud.minNodePixelSize = value
})
appearanceFolder.add(settings, 'maxNodesToGPUPerFrame', [1, 2, 4, 8, 16, 32, 64])
  .name('1フレームの追加ノード数').onChange((value: number) => {
    if (cloud) cloud.maxNodesToGPUPerFrame = value
  })
appearanceFolder.add(settings, 'showBoundingBoxes').name('ノードの bbox を表示').onChange((value: boolean) => {
  if (cloud) cloud.showBoundingBoxes = value
})
const clipFolder = gui.addFolder('クリッピング')
const boxFolder = clipFolder.addFolder('ボックス')
boxFolder.add(clipSettings, 'boxEnabled').name('有効')
boxFolder.add(clipSettings, 'boxMode', { '内側を消す': 'hide-inside', '内側だけ残す': 'keep-inside' }).name('モード')
boxFolder.add(clipSettings, 'boxPrune').name('範囲外ノードを読まない')
boxFolder.add(clipSettings, 'showBox').name('枠を表示')
for (const axis of ['X', 'Y', 'Z'] as const) {
  boxFolder.add(clipSettings, `center${axis}`, -0.25, 1.25, 0.005).name(`中心 ${axis}`)
}
for (const axis of ['X', 'Y', 'Z'] as const) {
  boxFolder.add(clipSettings, `size${axis}`, 0.01, 1.5, 0.005).name(`サイズ ${axis}`)
}
boxFolder.add(clipSettings, 'rotationZ', -180, 180, 1).name('Z 軸回転 (°)')
const planeFolder = clipFolder.addFolder('平面')
planeFolder.add(clipSettings, 'planeEnabled').name('有効')
planeFolder.add(clipSettings, 'planeAxis', ['x', 'y', 'z']).name('法線の軸')
planeFolder.add(clipSettings, 'planeOffset', 0, 1, 0.005).name('位置')
planeFolder.add(clipSettings, 'planeFlip').name('残す側を反転')
planeFolder.add(clipSettings, 'planePrune').name('範囲外ノードを読まない')
clipFolder.onChange(() => {
  applyClipping()
  requestRender()
})
clipFolder.close()
const pickFolder = gui.addFolder('ピック')
pickFolder.add(settings, 'hoverPick').name('カーソル位置の点を表示').onChange((value: boolean) => {
  if (value) pickRequested = true
  else showPick(null)
})
pickFolder.add(settings, 'pickRadius', 0, 20, 1).name('許容距離 (px)').onChange(() => { pickRequested = true })
const pickControllers = [
  pickFolder.add(picked, 'node').name('ノード').disable(),
  pickFolder.add(picked, 'index').name('点番号').disable(),
  pickFolder.add(picked, 'position').name('座標').disable(),
  pickFolder.add(picked, 'attributes').name('属性').disable(),
]
const infoFolder = gui.addFolder('データ情報')
const infoControllers = [
  infoFolder.add(info, 'source').name('読み込み元').disable(),
  infoFolder.add(info, 'points').name('点数').disable(),
  infoFolder.add(info, 'encoding').name('符号化').disable(),
  infoFolder.add(info, 'projection').name('座標系').disable(),
  infoFolder.add(info, 'attributes').name('属性').disable(),
]
infoFolder.close()
const statsFolder = gui.addFolder('取得統計')
const statControllers = [
  statsFolder.add(fetchStats, 'nodes').name('取得ノード数').disable(),
  statsFolder.add(fetchStats, 'requests').name('Range リクエスト数').disable(),
  statsFolder.add(fetchStats, 'average').name('平均ノード/リクエスト').disable(),
]
statsFolder.add(actions, 'clearFetchStats').name('カウントをクリア')
const performanceFolder = gui.addFolder('描画性能')
performanceFolder.add(settings, 'continuousRender').name('毎フレーム描画（計測用）').onChange(requestRender)
const pixelRatios: Record<string, number> = { '0.5': 0.5, '1': 1, '1.5': 1.5, '2': 2 }
pixelRatios[`端末の値 (${devicePixelRatio})`] = devicePixelRatio
performanceFolder.add(settings, 'pixelRatio', pixelRatios).name('pixelRatio').onChange((value: number) => {
  // setPixelRatio resizes the drawing buffer for the current CSS size.
  renderer.setPixelRatio(value)
  requestRender()
})
const performanceControllers = [
  performanceFolder.add(performanceStats, 'fps').name('描画 FPS').disable(),
  performanceFolder.add(performanceStats, 'frameMs').name('描画間隔').disable(),
  performanceFolder.add(performanceStats, 'cpuMs').name('render() CPU 時間').disable(),
  performanceFolder.add(performanceStats, 'gpuMs').name('GPU 時間').disable(),
  performanceFolder.add(performanceStats, 'drawCalls').name('ドローコール').disable(),
  performanceFolder.add(performanceStats, 'points').name('描画点数').disable(),
]
performanceFolder.close()
const timingFolder = gui.addFolder('読み込み計測')
const timingControllers = [
  timingFolder.add(timing, 'state').name('状態').disable(),
  timingFolder.add(timing, 'elapsed').name('経過時間').disable(),
  timingFolder.add(timing, 'decodedReady').name('復号完了').disable(),
  timingFolder.add(timing, 'sceneReady').name('表示完了').disable(),
  timingFolder.add(timing, 'required').name('復号済み / 必要').disable(),
  timingFolder.add(timing, 'pendingScene').name('描画待ちノード').disable(),
  timingFolder.add(timing, 'sceneConversions').name('描画に追加').disable(),
]
const timingDetails = timingFolder.addFolder('時間の内訳')
timingControllers.push(
  timingDetails.add(timing, 'batches').name('完了 / 開始バッチ').disable(),
  timingDetails.add(timing, 'activeBatches').name('処理中バッチ').disable(),
  timingDetails.add(timing, 'lastBatch').name('最終バッチ完了').disable(),
  timingDetails.add(timing, 'lastConversion').name('最終描画追加').disable(),
  timingDetails.add(timing, 'hierarchy').name('階層の取得').disable(),
  timingDetails.add(timing, 'hierarchyMs').name('階層取得時間').disable(),
  timingDetails.add(timing, 'fetchMs').name('ノード取得時間').disable(),
  timingDetails.add(timing, 'setupMs').name('デコーダー準備').disable(),
  timingDetails.add(timing, 'brotliMs').name('Brotli 展開').disable(),
  timingDetails.add(timing, 'attributesMs').name('属性デコード').disable(),
  timingDetails.add(timing, 'fetchedBytes').name('取得量').disable(),
  timingDetails.add(timing, 'throttled').name('429/503 応答').disable(),
  timingDetails.add(timing, 'aborted').name('中断したリクエスト').disable(),
)
timingDetails.close()
timingFolder.add(actions, 'resetMeasurement').name('計測をリセット')
timingFolder.add(actions, 'copyMeasurement').name('計測結果をコピー')
timingFolder.close()

const scene = new Scene()
const camera = new PerspectiveCamera(60, 1, 0.01, 1_000_000)
camera.up.set(0, 0, 1)
camera.position.set(10, -10, 10)
// MSAA costs more than it gains for square point sprites.
const renderer = new WebGLRenderer({ antialias: false, alpha: true })
renderer.setPixelRatio(settings.pixelRatio)
viewport.append(renderer.domElement)
const profiler = new RenderProfiler(renderer)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

// One clipping shared by every cloud loaded in this page; the library notices edits on update().
const clipping = new PotreeV2Clipping()
const clipBox = clipping.addBox({ matrix: new Matrix4(), mode: clipSettings.boxMode, enabled: false })
const clipPlane = clipping.addPlane({ plane: new Plane(new Vector3(0, 0, 1), 0), enabled: false })
const edges = new EdgesGeometry(new BoxGeometry(1, 1, 1))
const clipBoxHelper = new LineSegments(edges, new LineBasicMaterial({ color: 0xffb347, toneMapped: false }))
clipBoxHelper.matrixAutoUpdate = false
clipBoxHelper.visible = false
scene.add(clipBoxHelper)

let cloud: PotreeV2PointCloud | undefined
let currentLoader: (() => Promise<PotreeV2PointCloud>) | undefined
let currentSource = '—'
let currentUrl: string | undefined
let requestId = 0
let frame = 0
let lastTimingDisplayAt = 0
// Render only when the camera, the scene or a setting changed.
let renderRequested = true
// Pointer position in CSS pixels on the canvas; picked again after it moves or the view changes.
let pointer: { x: number; y: number } | undefined
let pickRequested = false
let picking = false
// World position of the picked point, marked on screen until the next pick.
let pickedPosition: Vector3 | undefined
const markerPosition = new Vector3()
// OrbitControls moved the camera this frame, by dragging or damping.
let cameraMoving = false

function requestRender() {
  renderRequested = true
}

function setStatus(message: string, error = false) {
  status.textContent = message
  status.dataset.error = String(error)
}

/** Place the box and plane relative to the loaded cloud's bounds, in its group's local space. */
function applyClipping() {
  const bounds = cloud?.metadata.boundingBox
  const extent = bounds ? new Vector3(...bounds.max).sub(new Vector3(...bounds.min)) : new Vector3(1, 1, 1)
  const c = clipSettings
  const center = new Vector3(c.centerX, c.centerY, c.centerZ).multiply(extent)
  const size = new Vector3(c.sizeX, c.sizeY, c.sizeZ).multiply(extent)
  const rotation = new Quaternion().setFromEuler(new Euler(0, 0, c.rotationZ * Math.PI / 180))
  clipBox.matrix.compose(center, rotation, size)
  clipBox.mode = c.boxMode
  clipBox.prune = c.boxPrune
  clipBox.enabled = c.boxEnabled && cloud !== undefined
  clipBoxHelper.matrix.copy(clipBox.matrix)
  clipBoxHelper.visible = clipBox.enabled && c.showBox
  const axis = { x: 0, y: 1, z: 2 }[c.planeAxis]
  const normal = new Vector3().setComponent(axis, c.planeFlip ? -1 : 1)
  // Keeps the side the normal points to, from `planeOffset` of the extent along the axis.
  clipPlane.plane.setFromNormalAndCoplanarPoint(normal, new Vector3().setComponent(axis, c.planeOffset * extent.getComponent(axis)))
  clipPlane.prune = c.planePrune
  clipPlane.enabled = c.planeEnabled && cloud !== undefined
}

function fitCloud(next: PotreeV2PointCloud) {
  const extent = new Vector3(...next.metadata.boundingBox.max).sub(new Vector3(...next.metadata.boundingBox.min))
  const center = extent.clone().multiplyScalar(0.5)
  const radius = Math.max(extent.length() * 0.5, 1)
  controls.target.copy(center)
  camera.position.copy(center).add(new Vector3(radius, -radius, radius * 0.75))
  camera.near = Math.max(radius / 100_000, 0.001)
  camera.far = Math.max(radius * 100, 100)
  camera.updateProjectionMatrix()
  controls.update()
}

/** Place the marker over the picked point; call after the camera or the viewport changes. */
function updatePickMarker() {
  if (!pickedPosition) {
    pickMarker.hidden = true
    return
  }
  markerPosition.copy(pickedPosition).project(camera)
  // Behind the camera or beyond its far plane.
  if (markerPosition.z < -1 || markerPosition.z > 1) {
    pickMarker.hidden = true
    return
  }
  const { clientWidth: width, clientHeight: height } = viewport
  pickMarker.style.transform =
    `translate(${(markerPosition.x + 1) / 2 * width}px, ${(1 - markerPosition.y) / 2 * height}px)`
  pickMarker.hidden = false
}

function showPick(result: PotreeV2PickResult | null) {
  pickedPosition = result?.position
  updatePickMarker()
  picked.node = result?.node ?? '—'
  picked.index = result ? String(result.index) : '—'
  picked.position = result ? result.sourcePosition.map(value => value.toFixed(3)).join(', ') : '—'
  picked.attributes = result
    ? Object.entries(result.attributes).map(([name, values]) => `${name}: ${values.join(', ')}`).join(' / ') || '—'
    : '—'
  for (const controller of pickControllers) controller.updateDisplay()
}

function startPick() {
  // Each pick redraws the nodes under the pointer, so wait until the camera stops.
  if (!pickRequested || picking || cameraMoving || !settings.hoverPick) return
  pickRequested = false
  const target = cloud
  if (!target || !pointer) { showPick(null); return }
  picking = true
  target.pick(renderer, camera, pointer.x, pointer.y, { radius: settings.pickRadius })
    .then(result => { if (target === cloud) showPick(result) })
    .catch(error => setStatus(error instanceof Error ? error.message : String(error), true))
    .finally(() => { picking = false })
}

function updateInfo(next?: PotreeV2PointCloud, source = '—') {
  info.source = source
  info.points = next ? next.metadata.points.toLocaleString() : '—'
  info.encoding = next?.metadata.encoding ?? '—'
  info.projection = next?.metadata.projection || '記載なし'
  info.attributes = next ? next.metadata.attributes.map(a => a.name).join(', ') : '—'
  for (const controller of infoControllers) controller.updateDisplay()
}

function updateFetchStats() {
  const current = cloud?.fetchStats
  const nodes = current?.fetchedNodes ?? 0
  const requests = current?.rangeRequests ?? 0
  if (fetchStats.nodes === nodes && fetchStats.requests === requests) return
  fetchStats.nodes = nodes
  fetchStats.requests = requests
  fetchStats.average = requests ? (nodes / requests).toFixed(1) : '—'
  for (const controller of statControllers) controller.updateDisplay()
}

function updateTiming() {
  const current = cloud?.loadDiagnostics
  const seconds = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(2)} s`
  const milliseconds = (value: number | undefined) => value == null ? '—' : `${value.toFixed(1)} ms`
  const values = current ? {
    state: current.state === 'complete' ? '完了' : '読み込み中',
    elapsed: seconds(current.seconds),
    decodedReady: seconds(current.decodedReadySeconds),
    sceneReady: seconds(current.sceneReadySeconds),
    required: `${current.decodedNodes} / ${current.requiredNodes}`,
    pendingScene: String(current.pendingSceneNodes),
    sceneConversions: String(current.sceneConversions),
    batches: `${current.completedBatches} / ${current.startedBatches}`,
    activeBatches: String(current.activeBatches),
    lastBatch: seconds(current.lastBatchDoneSeconds),
    lastConversion: seconds(current.lastSceneConversionSeconds),
    hierarchy: `${current.hierarchyCompleted} / ${current.hierarchyStarted}`,
    hierarchyMs: milliseconds(current.hierarchyMs),
    fetchMs: milliseconds(current.fetchMs),
    setupMs: milliseconds(current.codecSetupMs),
    brotliMs: milliseconds(current.brotliMs),
    attributesMs: milliseconds(current.attributesMs),
    fetchedBytes: `${(current.fetchedBytes / (1024 * 1024)).toFixed(2)} MiB`,
    throttled: String(current.throttledResponses),
    aborted: String(current.abortedRequests),
  } : Object.fromEntries(Object.keys(timing).map(key => [key, '—'])) as typeof timing
  let changed = false
  for (const key of Object.keys(timing) as (keyof typeof timing)[]) {
    if (timing[key] !== values[key]) { timing[key] = values[key]; changed = true }
  }
  if (changed) for (const controller of timingControllers) controller.updateDisplay()
}

async function openCloud(loader: () => Promise<PotreeV2PointCloud>, source: string, url?: string) {
  const current = ++requestId
  currentLoader = loader
  currentSource = source
  currentUrl = url
  cloud?.dispose()
  if (cloud) scene.remove(cloud.group)
  cloud = undefined
  requestRender()
  showPick(null)
  updateInfo()
  updateFetchStats()
  updateTiming()
  setStatus('読み込み中…')
  try {
    const next = await loader()
    if (current !== requestId) { next.dispose(); return }
    cloud = next
    updateFetchStats()
    updateTiming()
    scene.add(next.group)
    fitCloud(next)
    applyClipping()
    requestRender()
    updateInfo(next, source)
    setStatus('読み込み完了。視点を動かすと詳細を追加で読み込みます。')
    history.replaceState(null, '', url ? `?url=${encodeURIComponent(url)}` : location.pathname)
  } catch (error) {
    if (current === requestId) setStatus(error instanceof Error ? error.message : String(error), true)
  }
}

function loadOptions() {
  return {
    pointSize: settings.pointSize,
    pointShape: settings.pointShape,
    pointSizeType: settings.pointSizeType,
    minPointSize: settings.minPointSize,
    maxPointSize: settings.maxPointSize,
    pointBudget: settings.pointBudgetMP * 1_000_000,
    minNodePixelSize: settings.minNodePixelSize,
    maxNodesToGPUPerFrame: settings.maxNodesToGPUPerFrame,
    showBoundingBoxes: settings.showBoundingBoxes,
    clipping,
    onError: (error: Error, node: string) => setStatus(`${node}: ${error.message}`, true),
  }
}

filesInput.addEventListener('change', () => {
  const files = Array.from(filesInput.files ?? [])
  filesInput.value = ''
  if (files.length === 0) return
  try {
    selectPotreeV2Files(files)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true)
    return
  }
  void openCloud(() => loadPotreeV2FromFiles(files, loadOptions()), 'ローカルファイル')
})

renderer.domElement.addEventListener('pointermove', event => {
  pointer = { x: event.offsetX, y: event.offsetY }
  pickRequested = true
})
renderer.domElement.addEventListener('pointerleave', () => {
  pointer = undefined
  pickRequested = true
})

const resize = new ResizeObserver(() => {
  const { width, height } = viewport.getBoundingClientRect()
  if (width <= 0 || height <= 0) return
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  requestRender()
})
resize.observe(viewport)

function updatePerformance() {
  const stats = profiler.poll()
  if (!stats) return
  performanceStats.fps = stats.fps.toFixed(1)
  performanceStats.frameMs = stats.frameMs ? `${stats.frameMs.toFixed(2)} ms` : '—'
  performanceStats.cpuMs = `${stats.cpuMs.toFixed(2)} ms`
  performanceStats.gpuMs = stats.gpuMs !== null ? `${stats.gpuMs.toFixed(2)} ms`
    : profiler.gpuTimerAvailable ? '—' : '非対応'
  performanceStats.drawCalls = stats.drawCalls.toLocaleString()
  performanceStats.points = stats.points.toLocaleString()
  for (const controller of performanceControllers) controller.updateDisplay()
}

function animate() {
  frame = requestAnimationFrame(animate)
  // OrbitControls reports movement, including damping after the pointer is released.
  cameraMoving = controls.update()
  if (cameraMoving) requestRender()
  if (cloud?.update(camera, viewport.clientHeight)) requestRender()
  updateFetchStats()
  const now = performance.now()
  if (now - lastTimingDisplayAt >= 200) {
    updateTiming()
    lastTimingDisplayAt = now
  }
  if (renderRequested || settings.continuousRender) {
    const changed = renderRequested
    renderRequested = false
    profiler.measure(() => renderer.render(scene, camera))
    updatePickMarker()
    // The point under the pointer may have changed with the view or the loaded nodes.
    if (changed) pickRequested = true
  } else {
    // Idle frames would count as long render intervals.
    profiler.resetInterval()
  }
  updatePerformance()
  startPick()
}
animate()
actions.loadUrl()

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(frame)
  resize.disconnect()
  cloud?.dispose()
  edges.dispose()
  controls.dispose()
  profiler.dispose()
  renderer.dispose()
  gui.destroy()
})
