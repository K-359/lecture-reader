import { OPS, Util, type PDFPageProxy } from 'pdfjs-dist'
import { textLineBoxes, type Box } from './textLayer'

/**
 * ページの中の「図」（グラフ・表・流れの図・画像など）の範囲を、PDF の描画命令から推定する。
 * 線や四角などの図形と画像の位置を集め、近いもの同士をまとめて1つの図とみなす。
 * これで、図の中のラベルを押したときは図の説明、本文を押したときは文字の読み上げ、と分けられる。
 *
 * 範囲はすべてページに対する 0〜1 の割合で返す。
 */

type Matrix = number[]
type Item = { box: Box; image: boolean }
type Cluster = { box: Box; paths: number; images: number }

/** これより離れた図形は別の図とみなす（ページの幅に対する割合） */
const GAP = 0.015
/** 図とみなす最小の大きさ（ページの幅・高さに対する割合） */
const MIN_SIZE = 0.05
/** 図形だけでできた図は、この数以上の図形があるときだけ図とみなす（見出しの下線や文字の背景の四角を除くため） */
const MIN_PATHS = 4
/** これより大きい図形はページの背景とみなして除く（ページの面積に対する割合） */
const BACKGROUND_AREA = 0.5

const PAINT_IMAGE = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
  OPS.paintSolidColorImageMask,
])

const cache = new WeakMap<PDFPageProxy, Promise<Box[]>>()

function area(b: Box) {
  return (b.right - b.left) * (b.bottom - b.top)
}

function union(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }
}

function near(a: Box, b: Box, gapX: number, gapY: number) {
  return a.left - gapX <= b.right && b.left - gapX <= a.right && a.top - gapY <= b.bottom && b.top - gapY <= a.bottom
}

/** 描画命令をたどり、図形と画像の範囲を集める */
async function collectItems(page: PDFPageProxy): Promise<Item[]> {
  const viewport = page.getViewport({ scale: 1 })
  const { fnArray, argsArray } = await page.getOperatorList()
  const items: Item[] = []
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []

  const add = (rect: number[], image: boolean) => {
    const out = [Infinity, Infinity, -Infinity, -Infinity]
    Util.axialAlignedBoundingBox(rect, Util.transform(viewport.transform, ctm), out)
    const [x0, y0, x1, y1] = out
    const box = { left: x0 / viewport.width, top: y0 / viewport.height, right: x1 / viewport.width, bottom: y1 / viewport.height }
    if (!Number.isFinite(box.left) || area(box) > BACKGROUND_AREA) return
    items.push({ box, image })
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] as unknown[]
    if (fn === OPS.save || fn === OPS.beginGroup) {
      stack.push(ctm)
    } else if (fn === OPS.restore || fn === OPS.endGroup || fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm
    } else if (fn === OPS.transform) {
      ctm = Util.transform(ctm, args as number[])
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      const matrix = args[0] as number[] | null
      if (matrix) ctm = Util.transform(ctm, matrix)
    } else if (fn === OPS.constructPath) {
      // args = [塗り方, 経路, 範囲]。endPath は切り抜き用で、何も描かない
      const [op, , minMax] = args as [number, unknown, number[] | null]
      if (op !== OPS.endPath && minMax) add(minMax, false)
    } else if (PAINT_IMAGE.has(fn)) {
      add([0, 0, 1, 1], true) // 画像は 1×1 の正方形を今の変換で引き伸ばして描かれる
    }
  }
  return items
}

/** 近い図形同士をまとめる */
function clusterItems(items: Item[], aspect: number): Cluster[] {
  const clusters: Cluster[] = []
  const gapY = GAP / aspect
  for (const item of items) {
    let merged: Cluster = { box: item.box, paths: item.image ? 0 : 1, images: item.image ? 1 : 0 }
    for (let i = clusters.length - 1; i >= 0; i--) {
      if (!near(clusters[i].box, merged.box, GAP, gapY)) continue
      const c = clusters[i]
      merged = { box: union(c.box, merged.box), paths: c.paths + merged.paths, images: c.images + merged.images }
      clusters.splice(i, 1)
    }
    clusters.push(merged)
  }
  // まとめた結果、別の塊と重なるようになることがあるので、重ならなくなるまで繰り返す
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < clusters.length && !changed; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (!near(clusters[i].box, clusters[j].box, GAP, gapY)) continue
        const a = clusters[i]
        const b = clusters[j]
        clusters[i] = { box: union(a.box, b.box), paths: a.paths + b.paths, images: a.images + b.images }
        clusters.splice(j, 1)
        changed = true
        break
      }
    }
  }
  return clusters
}

async function buildFigures(page: PDFPageProxy): Promise<Box[]> {
  const viewport = page.getViewport({ scale: 1 })
  const aspect = viewport.height / viewport.width
  const clusters = clusterItems(await collectItems(page), aspect)
  const figures = clusters
    .filter((c) => c.box.right - c.box.left >= MIN_SIZE && c.box.bottom - c.box.top >= MIN_SIZE)
    .filter((c) => c.images > 0 || c.paths >= MIN_PATHS)
    .map((c) => c.box)

  // 図のすぐ外にある軸の名前や目盛りの数字などのラベルも、図の範囲に含める
  const lines = await textLineBoxes(page).catch(() => [])
  return figures.map((fig) => {
    let box = fig
    for (let pass = 0; pass < 2; pass++) {
      for (const l of lines) {
        const gap = l.size * 1.5
        if (near(box, l.box, gap * aspect, gap)) box = union(box, l.box)
      }
    }
    return box
  })
}

/** ページの図の範囲の一覧 */
export function findFigures(page: PDFPageProxy): Promise<Box[]> {
  let p = cache.get(page)
  if (!p) {
    p = buildFigures(page)
    cache.set(page, p)
  }
  return p
}

/** ページを開いたときに先に調べておく */
export function prefetchFigures(page: PDFPageProxy) {
  void findFigures(page).catch(() => undefined)
}

/** (x, y) を含む図の範囲。なければ null。重なっているときは小さい方 */
export async function figureAt(page: PDFPageProxy, x: number, y: number): Promise<Box | null> {
  const figures = await findFigures(page).catch(() => [])
  const hits = figures.filter((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)
  return hits.sort((a, b) => area(a) - area(b))[0] ?? null
}
