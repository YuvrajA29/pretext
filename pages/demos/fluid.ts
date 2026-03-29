import {
  prepareWithSegments,
  layoutWithLines,
  type PreparedTextWithSegments,
} from '../../src/layout.ts'

// ─── Demo text ────────────────────────────────────────────────────────────────

const DEMO_TEXT =
  'Typography is the art and craft of arranging type. The arrangement of letters ' +
  'involves selecting typefaces, point sizes, line lengths, and spacing. Good typography ' +
  'sets the tone for communication — a page well set in type reads almost invisibly, ' +
  'letting the words carry the reader forward without friction. Every newspaper, novel, ' +
  'and website depends on these invisible decisions.'

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT = "17px 'Helvetica Neue', Helvetica, Arial, sans-serif"
const LINE_HEIGHT = 30

const CANVAS_W = 800
const CANVAS_H = 520

// Container geometry (canvas coords)
const CONT_Y = 50     // container top
const CONT_H = 420    // container height
const CONT_PAD_X = 36 // horizontal padding inside container for text
const CONT_PAD_TOP = 28

// Container width constraints
const MIN_W = 200
const MAX_W = 724
const DEFAULT_W = 580

// Fluid simulation
const FLUID_COLS = 120
const WAVE_SPEED = 0.26
const WAVE_DAMP = 0.983
const WAVE_RESTORE = 0.0045
const WORD_PUSH = 0.7

// Word physics
const SPRING_X = 0.13
const SPRING_Y = 0.11
const DAMP_X = 0.26
const DAMP_Y = 0.23

// Pour mode
const MAX_TILT = 0.42

// ─── Types ────────────────────────────────────────────────────────────────────

type WordToken = {
  text: string
  segIdx: number
  width: number
  lineHistory: Set<number>
}

type WordTarget = {
  lineIdx: number
  cx: number
  cy: number
}

type WordBody = {
  x: number
  y: number
  vx: number
  vy: number
}

type FluidState = {
  h: Float32Array
  v: Float32Array
  restH: number
}

// ─── Module-level state ──────────────────────────────────────────────────────

let prepared: PreparedTextWithSegments
let tokens: WordToken[] = []
let bodies: WordBody[] = []
let targets: WordTarget[] = []
let fluid: FluidState

let containerWidth = DEFAULT_W
let lastLineCount = -1

let mode: 'normal' | 'pour' = 'normal'
let frozen = false
let tiltAngle = 0
let hoveredIdx: number | null = null

let dragging = false
let dragStartX = 0
let dragStartW = 0
let mouseCanvasX = CANVAS_W / 2

// ─── Geometry ─────────────────────────────────────────────────────────────────

function containerLeft(): number {
  return (CANVAS_W - containerWidth) / 2
}

function textLayoutWidth(): number {
  return containerWidth - 2 * CONT_PAD_X
}

function restHFromLineCount(lineCount: number): number {
  return CONT_PAD_TOP + lineCount * LINE_HEIGHT
}

// ─── Pretext integration ──────────────────────────────────────────────────────

function buildWordTokens(p: PreparedTextWithSegments): WordToken[] {
  const result: WordToken[] = []
  for (let i = 0; i < p.segments.length; i++) {
    const kind = p.kinds[i]
    const seg = p.segments[i]
    const w = p.widths[i]
    if (kind === 'text' && seg !== undefined && w !== undefined) {
      result.push({ text: seg, segIdx: i, width: w, lineHistory: new Set() })
    }
  }
  return result
}

function computeTargets(lw: number, cx: number): { targets: WordTarget[]; lineCount: number } {
  const result = layoutWithLines(prepared, lw, LINE_HEIGHT)

  const segToTok = new Map<number, number>()
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok !== undefined) segToTok.set(tok.segIdx, i)
  }

  const newTargets: WordTarget[] = tokens.map((tok) => ({
    lineIdx: 0,
    cx: cx + CONT_PAD_X + tok.width / 2,
    cy: CONT_Y + CONT_PAD_TOP + LINE_HEIGHT / 2,
  }))

  for (let li = 0; li < result.lines.length; li++) {
    const line = result.lines[li]
    if (line === undefined) continue
    let xOff = 0
    for (let si = line.start.segmentIndex; si < line.end.segmentIndex; si++) {
      const kind = prepared.kinds[si]
      const w = prepared.widths[si]
      if (kind === 'text') {
        const tidx = segToTok.get(si)
        const tok = tidx !== undefined ? tokens[tidx] : undefined
        if (tidx !== undefined && tok !== undefined) {
          newTargets[tidx] = {
            lineIdx: li,
            cx: cx + CONT_PAD_X + xOff + tok.width / 2,
            cy: CONT_Y + CONT_PAD_TOP + li * LINE_HEIGHT + LINE_HEIGHT / 2,
          }
          tok.lineHistory.add(li)
        }
      }
      xOff += w ?? 0
    }
  }

  return { targets: newTargets, lineCount: result.lineCount }
}

// ─── Fluid simulation ─────────────────────────────────────────────────────────

function initFluid(lineCount: number): FluidState {
  const restH = restHFromLineCount(lineCount)
  const h = new Float32Array(FLUID_COLS)
  const v = new Float32Array(FLUID_COLS)
  h.fill(restH)
  for (let i = 0; i < FLUID_COLS; i++) {
    h[i] = (h[i] ?? restH) + Math.sin(i * 0.18) * 2.5 + Math.cos(i * 0.31) * 1.5
  }
  return { h, v, restH }
}

function stepFluid(): void {
  const { h, v, restH } = fluid
  const n = FLUID_COLS

  for (let i = 1; i < n - 1; i++) {
    const hi = h[i] ?? restH
    const hprev = h[i - 1] ?? restH
    const hnext = h[i + 1] ?? restH
    v[i] = (v[i] ?? 0) + WAVE_SPEED * (hprev + hnext - 2 * hi)
  }
  v[0] = (v[0] ?? 0) + WAVE_SPEED * ((h[1] ?? restH) - (h[0] ?? restH))
  v[n - 1] = (v[n - 1] ?? 0) + WAVE_SPEED * ((h[n - 2] ?? restH) - (h[n - 1] ?? restH))

  for (let i = 0; i < n; i++) {
    h[i] = (h[i] ?? restH) + (v[i] ?? 0)
    v[i] = (v[i] ?? 0) * WAVE_DAMP
    h[i] = (h[i] ?? restH) + (restH - (h[i] ?? restH)) * WAVE_RESTORE
  }
}

function displaceFluid(): void {
  const { h } = fluid
  const cx = containerLeft()
  const cellW = containerWidth / FLUID_COLS

  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    if (b === undefined || Math.abs(b.vy) < 0.25) continue
    const tok = tokens[i]
    if (tok === undefined) continue

    const leftX = b.x - tok.width / 2 - cx
    const rightX = b.x + tok.width / 2 - cx
    const c0 = Math.max(0, Math.floor(leftX / cellW))
    const c1 = Math.min(FLUID_COLS - 1, Math.ceil(rightX / cellW))
    const n = Math.max(1, c1 - c0 + 1)
    const disp = (b.vy * WORD_PUSH) / n
    for (let c = c0; c <= c1; c++) {
      h[c] = (h[c] ?? fluid.restH) + disp
    }
  }
}

function getSurfaceY(canvasX: number): number {
  const cx = containerLeft()
  const cellW = containerWidth / FLUID_COLS
  const col = (canvasX - cx) / cellW
  const ci = Math.max(0, Math.min(FLUID_COLS - 2, Math.floor(col)))
  const cf = Math.max(0, Math.min(1, col - ci))
  const ha = fluid.h[ci] ?? fluid.restH
  const hb = fluid.h[ci + 1] ?? fluid.restH
  return CONT_Y + ha * (1 - cf) + hb * cf
}

// ─── Word physics ──────────────────────────────────────────────────────────────

function stepBodies(): void {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    const t = targets[i]
    if (b === undefined || t === undefined) continue

    const ax = SPRING_X * (t.cx - b.x) - DAMP_X * b.vx
    const surfY = getSurfaceY(b.x)
    const surfDelta = surfY - (CONT_Y + fluid.restH)
    const targetY = t.cy + surfDelta * 0.13
    const ay = SPRING_Y * (targetY - b.y) - DAMP_Y * b.vy

    b.vx += ax
    b.vy += ay
    b.x += b.vx
    b.y += b.vy
  }
}

// ─── Layout update ─────────────────────────────────────────────────────────────

function updateLayout(): void {
  const baseLW = textLayoutWidth()
  const effectiveLW = mode === 'pour'
    ? Math.max(60, baseLW * Math.cos(tiltAngle * 2.2))
    : baseLW

  const cx = containerLeft()
  const { targets: newTargets, lineCount } = computeTargets(Math.max(1, effectiveLW), cx)
  targets = newTargets

  if (lineCount !== lastLineCount) {
    lastLineCount = lineCount
    const newRestH = restHFromLineCount(lineCount)
    if (Math.abs(newRestH - fluid.restH) > LINE_HEIGHT * 0.4) {
      for (let i = 0; i < FLUID_COLS; i++) {
        fluid.v[i] = (fluid.v[i] ?? 0) + (Math.random() - 0.5) * 2.0
      }
    }
    fluid.restH = newRestH
  }

  widthLabel.textContent = `${Math.round(containerWidth)}px · ${lineCount} line${lineCount === 1 ? '' : 's'}`
}

// ─── Rendering helpers ─────────────────────────────────────────────────────────

function rr(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function buildSurfacePath(ctx: CanvasRenderingContext2D): void {
  const cx = containerLeft()
  const cellW = containerWidth / FLUID_COLS
  const restH = fluid.restH

  // Build point arrays inline to avoid repeated array allocation + index checks
  const count = FLUID_COLS
  ctx.moveTo(cx + 0.5 * cellW, CONT_Y + (fluid.h[0] ?? restH))

  for (let i = 0; i < count - 1; i++) {
    // Clamp neighbour indices
    const i0 = Math.max(0, i - 1)
    const i1 = i
    const i2 = i + 1
    const i3 = Math.min(count - 1, i + 2)

    const x1 = cx + (i1 + 0.5) * cellW
    const x2 = cx + (i2 + 0.5) * cellW
    const x0 = cx + (i0 + 0.5) * cellW
    const x3 = cx + (i3 + 0.5) * cellW

    const y0 = CONT_Y + (fluid.h[i0] ?? restH)
    const y1 = CONT_Y + (fluid.h[i1] ?? restH)
    const y2 = CONT_Y + (fluid.h[i2] ?? restH)
    const y3 = CONT_Y + (fluid.h[i3] ?? restH)

    ctx.bezierCurveTo(
      x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6,
      x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6,
      x2, y2,
    )
  }
}

// ─── Main render ──────────────────────────────────────────────────────────────

function renderFrame(ctx: CanvasRenderingContext2D): void {
  const cx = containerLeft()
  const contRight = cx + containerWidth
  const contBottom = CONT_Y + CONT_H

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
  ctx.fillStyle = '#f5f1ea'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  const doTilt = mode === 'pour' && Math.abs(tiltAngle) > 0.002
  if (doTilt) {
    ctx.save()
    ctx.translate(CANVAS_W / 2, CANVAS_H / 2)
    ctx.rotate(tiltAngle)
    ctx.translate(-CANVAS_W / 2, -CANVAS_H / 2)
  }

  // Container background
  ctx.fillStyle = '#fefcf7'
  rr(ctx, cx, CONT_Y, containerWidth, CONT_H, 12)
  ctx.fill()

  // Water body — clip to container
  ctx.save()
  rr(ctx, cx, CONT_Y, containerWidth, CONT_H, 12)
  ctx.clip()

  const approxSurfY = CONT_Y + fluid.restH
  const waterGrad = ctx.createLinearGradient(0, approxSurfY, 0, contBottom)
  waterGrad.addColorStop(0, 'rgba(92, 164, 212, 0.82)')
  waterGrad.addColorStop(0.5, 'rgba(68, 140, 200, 0.74)')
  waterGrad.addColorStop(1, 'rgba(48, 112, 180, 0.68)')
  ctx.fillStyle = waterGrad
  ctx.beginPath()
  buildSurfacePath(ctx)
  ctx.lineTo(contRight, contBottom)
  ctx.lineTo(cx, contBottom)
  ctx.closePath()
  ctx.fill()

  // Caustic shimmer
  const t = performance.now() / 1000
  ctx.save()
  ctx.globalAlpha = 0.055
  ctx.globalCompositeOperation = 'screen'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 18
  ctx.beginPath()
  for (let x = cx; x <= contRight; x += 2) {
    const y = approxSurfY + 30 + Math.sin((x - cx) * 0.04 + t * 0.9) * 18 + Math.cos((x - cx) * 0.07 - t * 0.6) * 10
    if (x === cx) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.restore()

  // Surface highlight
  ctx.strokeStyle = 'rgba(190, 230, 252, 0.88)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  buildSurfacePath(ctx)
  ctx.stroke()

  ctx.restore() // end clip

  // Words
  ctx.font = FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = bodies.length - 1; i >= 0; i--) {
    renderWord(ctx, i)
  }

  // Container border
  ctx.strokeStyle = 'rgba(195, 175, 155, 0.5)'
  ctx.lineWidth = 1.5
  rr(ctx, cx, CONT_Y, containerWidth, CONT_H, 12)
  ctx.stroke()

  renderHandle(ctx)

  if (doTilt) ctx.restore()
}

function renderWord(ctx: CanvasRenderingContext2D, i: number): void {
  const b = bodies[i]
  const tok = tokens[i]
  if (b === undefined || tok === undefined) return

  const hovered = i === hoveredIdx
  const padH = 10, padV = 4
  const cardW = tok.width + padH * 2
  const cardH = LINE_HEIGHT - padV
  const rx = b.x - cardW / 2
  const ry = b.y - cardH / 2

  const surfY = getSurfaceY(b.x)
  const submerged = b.y > surfY - cardH * 0.3

  ctx.save()
  if (submerged) ctx.globalAlpha = 0.82

  ctx.shadowColor = submerged ? 'rgba(20, 70, 130, 0.2)' : 'rgba(0, 0, 0, 0.1)'
  ctx.shadowBlur = hovered ? 12 : 7
  ctx.shadowOffsetY = submerged ? 1 : 2

  ctx.fillStyle = submerged ? '#ddeef9' : hovered ? '#fff8f3' : '#ffffff'
  rr(ctx, rx, ry, cardW, cardH, 5)
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  if (hovered) {
    ctx.strokeStyle = '#955f3b'
    ctx.lineWidth = 1.5
    rr(ctx, rx, ry, cardW, cardH, 5)
    ctx.stroke()
  }

  ctx.fillStyle = submerged ? '#1b4a7a' : '#201b18'
  ctx.fillText(tok.text, b.x, b.y)
  ctx.restore()
}

function renderHandle(ctx: CanvasRenderingContext2D): void {
  const cx = containerLeft()
  const hx = cx + containerWidth
  const hy = CONT_Y + CONT_H / 2
  const near = dragging || Math.abs(mouseCanvasX - hx) < 18

  ctx.strokeStyle = near ? 'rgba(149, 95, 59, 0.6)' : 'rgba(180, 160, 140, 0.35)'
  ctx.lineWidth = near ? 1.5 : 1
  ctx.setLineDash([3, 5])
  ctx.beginPath()
  ctx.moveTo(hx, CONT_Y + 16)
  ctx.lineTo(hx, CONT_Y + CONT_H - 16)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = near ? '#955f3b' : '#c4b0a0'
  ctx.beginPath()
  ctx.arc(hx, hy, 7, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(hx - 2.5, hy - 2.5)
  ctx.lineTo(hx - 5, hy)
  ctx.lineTo(hx - 2.5, hy + 2.5)
  ctx.moveTo(hx + 2.5, hy - 2.5)
  ctx.lineTo(hx + 5, hy)
  ctx.lineTo(hx + 2.5, hy + 2.5)
  ctx.stroke()
  ctx.lineCap = 'butt'
}

// ─── Hit testing ───────────────────────────────────────────────────────────────

function hitTestWord(mx: number, my: number): number | null {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    const tok = tokens[i]
    if (b === undefined || tok === undefined) continue
    const cardW = tok.width + 20
    const cardH = LINE_HEIGHT - 4
    if (
      mx >= b.x - cardW / 2 && mx <= b.x + cardW / 2 &&
      my >= b.y - cardH / 2 && my <= b.y + cardH / 2
    ) return i
  }
  return null
}

function toCanvasCoords(e: PointerEvent | MouseEvent): { cx: number; cy: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    cx: (e.clientX - rect.left) * (CANVAS_W / rect.width),
    cy: (e.clientY - rect.top) * (CANVAS_H / rect.height),
  }
}

// ─── Event handlers ────────────────────────────────────────────────────────────

function onPointerDown(e: PointerEvent): void {
  const { cx: mcx } = toCanvasCoords(e)
  const hx = containerLeft() + containerWidth
  if (Math.abs(mcx - hx) < 20) {
    dragging = true
    dragStartX = mcx
    dragStartW = containerWidth
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }
}

function onPointerMove(e: PointerEvent): void {
  const { cx: mcx, cy: mcy } = toCanvasCoords(e)
  mouseCanvasX = mcx

  if (dragging) {
    containerWidth = Math.max(MIN_W, Math.min(MAX_W, dragStartW + (mcx - dragStartX)))
    updateLayout()
  }

  if (mode === 'pour') {
    tiltAngle = (mcx / CANVAS_W - 0.5) * MAX_TILT * 2
    updateLayout()
  }

  hoveredIdx = hitTestWord(mcx, mcy)
  updateTooltip(e)

  const hx = containerLeft() + containerWidth
  canvas.style.cursor = Math.abs(mcx - hx) < 20 ? 'ew-resize' : 'default'
}

function onPointerUp(): void {
  dragging = false
}

function onDblClick(): void {
  frozen = !frozen
  settleBtn.style.display = frozen ? 'inline-block' : 'none'
}

function onMouseLeave(): void {
  hoveredIdx = null
  tooltip.style.display = 'none'
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function updateTooltip(e: PointerEvent): void {
  if (hoveredIdx === null) {
    tooltip.style.display = 'none'
    return
  }
  const tok = tokens[hoveredIdx]
  if (tok === undefined) {
    tooltip.style.display = 'none'
    return
  }
  tooltip.textContent = (
    `"${tok.text}"\n` +
    `width:  ${tok.width.toFixed(1)}px\n` +
    `kind:   text\n` +
    `lines:  ${tok.lineHistory.size}`
  )
  tooltip.style.display = 'block'
  tooltip.style.left = `${e.clientX + 16}px`
  tooltip.style.top = `${e.clientY - 8}px`
}

// ─── Animation loop ────────────────────────────────────────────────────────────

function tick(): void {
  requestAnimationFrame(tick)
  if (!frozen) {
    displaceFluid()
    stepFluid()
    stepBodies()
  }
  renderFrame(ctx)
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const tooltip = document.getElementById('tooltip') as HTMLDivElement
const pourBtn = document.getElementById('pour-btn') as HTMLButtonElement
const settleBtn = document.getElementById('settle-btn') as HTMLButtonElement
const widthLabel = document.getElementById('width-label') as HTMLSpanElement

// ─── Init ─────────────────────────────────────────────────────────────────────

const dpr = window.devicePixelRatio || 1
canvas.width = CANVAS_W * dpr
canvas.height = CANVAS_H * dpr
canvas.style.width = `${CANVAS_W}px`
canvas.style.height = `${CANVAS_H}px`
const ctx = canvas.getContext('2d')!
ctx.scale(dpr, dpr)

canvas.addEventListener('pointerdown', onPointerDown)
canvas.addEventListener('pointermove', onPointerMove)
canvas.addEventListener('pointerup', onPointerUp)
canvas.addEventListener('dblclick', onDblClick)
canvas.addEventListener('mouseleave', onMouseLeave)

pourBtn.addEventListener('click', () => {
  mode = mode === 'pour' ? 'normal' : 'pour'
  pourBtn.classList.toggle('active', mode === 'pour')
  if (mode === 'normal') {
    tiltAngle = 0
    updateLayout()
  }
})

settleBtn.addEventListener('click', () => {
  frozen = false
  settleBtn.style.display = 'none'
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    if (b !== undefined) {
      b.vx *= 0.08
      b.vy *= 0.08
    }
  }
  for (let i = 0; i < FLUID_COLS; i++) {
    fluid.v[i] = (fluid.v[i] ?? 0) + (Math.random() - 0.5) * 1.2
  }
})

document.fonts.ready.then(() => {
  prepared = prepareWithSegments(DEMO_TEXT, FONT)
  tokens = buildWordTokens(prepared)

  const cx = containerLeft()
  const { targets: initTargets, lineCount } = computeTargets(textLayoutWidth(), cx)
  targets = initTargets
  lastLineCount = lineCount

  fluid = initFluid(lineCount)
  bodies = targets.map((t) => ({ x: t.cx, y: t.cy, vx: 0, vy: 0 }))

  widthLabel.textContent = `${Math.round(containerWidth)}px · ${lineCount} lines`

  requestAnimationFrame(tick)
})
