import { Util, type PDFPageProxy } from 'pdfjs-dist'
import type { ReadUnit } from './api'

/**
 * PDF に埋め込まれた文字データから、クリックした位置の「1行」や「まとまり」を取り出す。
 * VLM を通さないので一瞬で返せる。文字データがない（スキャンした）PDF や、
 * 図の上をクリックしたときは null を返し、呼び出し側で VLM に回す。
 *
 * 座標はすべて「拡大率 1 のときのページ上の位置（左上が原点）」で扱う。
 */

export type Box = { left: number; top: number; right: number; bottom: number }

type Run = { str: string; box: Box; size: number; baseline: number }

type Line = { text: string; box: Box; size: number; baseline: number }

export type TextHit = {
  text: string
  /** 読んでいる行の範囲。ページに対する 0〜1 の割合 */
  boxes: Box[]
}

const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/
const ASCII_WORD = /[A-Za-z0-9]/
/** 行頭の箇条書きの印・番号 */
const BULLET = /^\s*([•・●○◦▪■□◆◇▶►‣\-–*]|\d+[.)．、]|[①-⑳]|[(（]\d+[)）])\s*/
const SYMBOL_BULLET = /^\s*[•・●○◦▪■□◆◇▶►‣\-–*]\s*/

const linesCache = new WeakMap<PDFPageProxy, Promise<{ lines: Line[]; width: number; height: number }>>()

function needsSpace(prev: string, next: string): boolean {
  const a = prev.at(-1) ?? ''
  const b = next[0] ?? ''
  if (a === ' ' || b === ' ' || a === '' || b === '') return false
  return !CJK.test(a) && !CJK.test(b)
}

function union(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }
}

async function buildLines(page: PDFPageProxy) {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()

  const runs: Run[] = []
  for (const item of content.items) {
    if (!('str' in item)) continue
    // 康熙部首（⼊⾨ など、見た目は同じでも別の文字）や全角英数を普通の文字にそろえ、
    // 空白の代わりに入っていることがある制御文字を空白にする
    // oxlint-disable-next-line no-control-regex -- 空白の代わりの制御文字をわざと拾う
    const str = item.str.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ')
    if (str.trim() === '') continue
    const tx = Util.transform(viewport.transform, item.transform)
    const size = Math.hypot(tx[2], tx[3])
    if (size <= 0) continue
    const left = tx[4]
    const baseline = tx[5]
    runs.push({
      str,
      size,
      baseline,
      box: { left, right: left + item.width, top: baseline - size * 0.9, bottom: baseline + size * 0.2 },
    })
  }

  // 上から順、同じ高さなら左から順に並べ、ベースラインがそろっていて横に続いているものを1行にまとめる
  runs.sort((a, b) => a.baseline - b.baseline || a.box.left - b.box.left)
  const groups: Run[][] = []
  for (const run of runs) {
    const group = groups.find((g) => {
      const last = g[g.length - 1]
      const size = Math.min(last.size, run.size)
      const sameRow = Math.abs(last.baseline - run.baseline) < size * 0.5
      // 行の左右どちら側でも、大きく離れているものは別の段（2段組み・表の隣など）とみなす
      const left = Math.min(...g.map((r) => r.box.left))
      const right = Math.max(...g.map((r) => r.box.right))
      const gap = Math.max(run.box.left - right, left - run.box.right, 0)
      return sameRow && gap < size * 1.5
    })
    if (group) group.push(run)
    else groups.push([run])
  }

  const lines: Line[] = groups.map((g) => {
    g.sort((a, b) => a.box.left - b.box.left)
    let text = ''
    let prevRight = -Infinity
    for (const r of g) {
      // 離れて置かれた英数字どうしの間にだけ空白を入れる（日本語の間には入れない）
      if (text && r.box.left - prevRight > r.size * 0.2 && needsSpace(text, r.str)) text += ' '
      text += r.str
      prevRight = r.box.right
    }
    const sizes = g.map((r) => r.size).sort((a, b) => a - b)
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      box: g.map((r) => r.box).reduce(union),
      size: sizes[Math.floor(sizes.length / 2)],
      baseline: g[0].baseline,
    }
  })
  lines.sort((a, b) => a.box.top - b.box.top)
  return { lines, width: viewport.width, height: viewport.height }
}

function getLines(page: PDFPageProxy) {
  let p = linesCache.get(page)
  if (!p) {
    p = buildLines(page)
    linesCache.set(page, p)
  }
  return p
}

/** 文字の行の範囲（ページに対する 0〜1 の割合）と文字の大きさ。図のラベルを図の範囲に含めるのに使う */
export async function textLineBoxes(page: PDFPageProxy): Promise<{ box: Box; size: number }[]> {
  const { lines, width, height } = await getLines(page)
  return lines.map((l) => ({
    box: { left: l.box.left / width, right: l.box.right / width, top: l.box.top / height, bottom: l.box.bottom / height },
    size: l.size / height,
  }))
}

/**
 * ページに文字データがあるか。ある（スキャンではない）のにクリック位置に文字がなければ、
 * そこは図の上だと考えられる
 */
export async function pageHasText(page: PDFPageProxy): Promise<boolean> {
  const { lines } = await getLines(page)
  return lines.length > 0
}

/** ページを開いたときに先に文字データを読んでおき、最初のクリックを速くする */
export function prefetchText(page: PDFPageProxy) {
  void getLines(page).catch(() => undefined)
}

function distance(box: Box, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right)
  const dy = Math.max(box.top - y, 0, y - box.bottom)
  return Math.hypot(dx, dy)
}

function overlapsHorizontally(a: Box, b: Box): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0
}

function similarSize(a: Line, b: Line): boolean {
  const r = a.size / b.size
  return r > 0.8 && r < 1.25
}

/** 文字化け（フォントに文字の対応表がない PDF）なら使わない */
function looksGarbled(text: string): boolean {
  const bad = text.match(/[�-]/g)?.length ?? 0
  return text.length === 0 || bad / text.length > 0.1
}

/** 「まとまり」: 行間が詰まっていて、同じくらいの文字の大きさで、次の箇条書きが始まるまでの行 */
function expandBlock(lines: Line[], start: number): Line[] {
  const picked = [lines[start]]

  const isNextLine = (upper: Line, lower: Line) =>
    lower.box.top - upper.box.bottom < Math.min(upper.size, lower.size) * 0.8 &&
    lower.box.top > upper.box.top &&
    overlapsHorizontally(upper.box, lower.box) &&
    similarSize(upper, lower)

  // 下へ
  let cur = lines[start]
  for (let i = start + 1; i < lines.length; i++) {
    const next = lines[i]
    if (next.box.top - cur.box.bottom > cur.size * 2) break
    if (!isNextLine(cur, next)) continue
    if (BULLET.test(next.text)) break
    picked.push(next)
    cur = next
  }
  // 上へ（クリックした行が箇条書きの始まりなら、それより上は別の項目）
  cur = lines[start]
  if (!BULLET.test(cur.text)) {
    for (let i = start - 1; i >= 0; i--) {
      const prev = lines[i]
      if (cur.box.top - prev.box.bottom > cur.size * 2) break
      if (!isNextLine(prev, cur)) continue
      picked.unshift(prev)
      cur = prev
      if (BULLET.test(prev.text)) break
    }
  }
  return picked
}

function joinLines(lines: Line[]): string {
  return lines.reduce((acc, l) => {
    if (!acc) return l.text
    const sep = ASCII_WORD.test(acc.at(-1) ?? '') && ASCII_WORD.test(l.text[0] ?? '') ? ' ' : ''
    return acc + sep + l.text
  }, '')
}

/**
 * クリック位置 (x, y)（ページに対する 0〜1 の割合）の文字を取り出す。
 * 近くに文字がないとき、文字データがないとき、文字化けしているときは null。
 */
export async function findTextAt(page: PDFPageProxy, x: number, y: number, unit: ReadUnit): Promise<TextHit | null> {
  const { lines, width, height } = await getLines(page)
  if (lines.length === 0) return null

  const px = x * width
  const py = y * height
  let best = -1
  let bestDist = Infinity
  lines.forEach((l, i) => {
    const d = distance(l.box, px, py)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  if (best < 0 || bestDist > lines[best].size * 0.8) return null

  const picked = unit === 'line' ? [lines[best]] : expandBlock(lines, best)
  const text = joinLines(picked).replace(SYMBOL_BULLET, '').trim()
  if (looksGarbled(text)) return null

  return {
    text,
    boxes: picked.map((l) => ({
      left: l.box.left / width,
      right: l.box.right / width,
      top: l.box.top / height,
      bottom: l.box.bottom / height,
    })),
  }
}
