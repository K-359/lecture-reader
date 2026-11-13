import { renderPage, type PDFPageProxy } from './pdf'
import type { Box } from './textLayer'

/** VLM に送るために高解像度で描くときのページの横幅（ピクセル） */
const HI_RES_WIDTH = 2400
/** 画像の長い辺の上限。これより大きいとモデル側で縮小されるだけなので、先に縮めて送る */
const MAX_SIDE = 1568
/** 拡大画像として切り出す範囲（ページの幅・高さに対する割合） */
const DETAIL_WIDTH_RATIO = 0.6
const DETAIL_HEIGHT_RATIO = 0.35

export type CapturedImages = {
  /** ページ全体（JPEG の base64） */
  pageImage: string
  /** クリック位置の周りの拡大（JPEG の base64） */
  detailImage: string
}

// 同じページを何度もクリックしたときに描き直さないよう、最後に描いたページだけ覚えておく
let cached: { page: PDFPageProxy; canvas: HTMLCanvasElement } | null = null

async function hiResCanvas(page: PDFPageProxy): Promise<HTMLCanvasElement> {
  if (cached?.page === page) return cached.canvas
  const canvas = document.createElement('canvas')
  await renderPage(page, canvas, HI_RES_WIDTH).promise
  cached = { page, canvas }
  return canvas
}

/** クリック位置の印。どんな背景でも見えるよう、白い縁取りの上に赤い円を重ねる */
function drawMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  ctx.save()
  ctx.lineWidth = Math.max(4, radius * 0.3)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = Math.max(2, radius * 0.15)
  ctx.strokeStyle = 'rgb(230, 0, 0)'
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

/** 選んだ範囲の印。白い縁取りの上に赤い四角を重ねる */
function drawRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, line: number) {
  ctx.save()
  ctx.lineWidth = line * 2
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.strokeRect(x, y, w, h)
  ctx.lineWidth = line
  ctx.strokeStyle = 'rgb(230, 0, 0)'
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}

function toJpegBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1]
}

/** src の (sx, sy, sw, sh) を、長い辺が MAX_SIDE 以下になるように新しい canvas へ写す */
function copyRegion(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number) {
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh))
  const out = document.createElement('canvas')
  out.width = Math.round(sw * scale)
  out.height = Math.round(sh * scale)
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height)
  return { canvas: out, ctx, scale }
}

/**
 * クリック位置 (x, y)（ページに対する 0〜1 の割合）から、VLM に送る2枚の画像を作る。
 */
export async function captureAround(page: PDFPageProxy, x: number, y: number): Promise<CapturedImages> {
  const src = await hiResCanvas(page)
  const W = src.width
  const H = src.height
  const px = x * W
  const py = y * H

  // 1枚目: ページ全体
  const whole = copyRegion(src, 0, 0, W, H)
  drawMarker(whole.ctx, px * whole.scale, py * whole.scale, W * 0.035 * whole.scale)

  // 2枚目: クリック位置の周り。ページの外にはみ出さないよう位置をずらす
  const dw = Math.round(W * DETAIL_WIDTH_RATIO)
  const dh = Math.round(H * DETAIL_HEIGHT_RATIO)
  const dx = Math.round(Math.min(Math.max(px - dw / 2, 0), W - dw))
  const dy = Math.round(Math.min(Math.max(py - dh / 2, 0), H - dh))
  const detail = copyRegion(src, dx, dy, dw, dh)
  drawMarker(detail.ctx, (px - dx) * detail.scale, (py - dy) * detail.scale, W * 0.035 * detail.scale)

  return { pageImage: toJpegBase64(whole.canvas), detailImage: toJpegBase64(detail.canvas) }
}

/** 選んだ範囲の周りに足す余白（ページの幅に対する割合）。範囲の端にかかった文字も読めるように */
const REGION_MARGIN = 0.03

/**
 * ドラッグで選んだ範囲 box（ページに対する 0〜1 の割合）から、VLM に送る2枚の画像を作る。
 * 1枚目はページ全体に範囲の四角を描いたもの、2枚目は範囲を拡大したもの。
 */
export async function captureRegion(page: PDFPageProxy, box: Box): Promise<CapturedImages> {
  const src = await hiResCanvas(page)
  const W = src.width
  const H = src.height
  const l = box.left * W
  const t = box.top * H
  const r = box.right * W
  const b = box.bottom * H
  const line = Math.max(3, W * 0.003)

  const whole = copyRegion(src, 0, 0, W, H)
  drawRect(whole.ctx, l * whole.scale, t * whole.scale, (r - l) * whole.scale, (b - t) * whole.scale, line * whole.scale)

  const m = W * REGION_MARGIN
  const cl = Math.max(0, l - m)
  const ct = Math.max(0, t - m)
  const cr = Math.min(W, r + m)
  const cb = Math.min(H, b + m)
  const detail = copyRegion(src, cl, ct, cr - cl, cb - ct)
  drawRect(
    detail.ctx,
    (l - cl) * detail.scale,
    (t - ct) * detail.scale,
    (r - l) * detail.scale,
    (b - t) * detail.scale,
    line * detail.scale,
  )

  return { pageImage: toJpegBase64(whole.canvas), detailImage: toJpegBase64(detail.canvas) }
}
