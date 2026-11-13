import type { CapturedImages } from './capture'
import type { Box } from './textLayer'

export type ReadUnit = 'line' | 'block'

export async function readAt(
  images: CapturedImages,
  x: number,
  y: number,
  unit: ReadUnit,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch('/api/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...images, x, y, unit }),
    signal,
  })
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
  if (!res.ok || typeof data.text !== 'string') {
    throw new Error(data.error ?? '読み取りに失敗しました。')
  }
  return data.text
}

/** 説明してほしい場所。point: クリックした点（その点にある図全体を説明）、rect: ドラッグで選んだ範囲 */
export type ExplainTarget = ({ type: 'point'; x: number; y: number }) | ({ type: 'rect' } & Box)

export type FigureKind = 'graph' | 'table' | 'flow' | 'diagram' | 'photo' | 'text' | 'other' | 'none'

export type Explanation = {
  kind: FigureKind
  /** 最初に読むひとこと */
  summary: string
  /** 「くわしく」で読む説明。文章だけの範囲などでは空 */
  detail: string
  /** 説明した図の範囲。分からなかったときは null */
  bbox: Box | null
}

export async function explainAt(images: CapturedImages, target: ExplainTarget, signal: AbortSignal): Promise<Explanation> {
  const res = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...images, target }),
    signal,
  })
  const data = (await res.json().catch(() => ({}))) as Partial<Explanation> & { error?: string }
  if (!res.ok || typeof data.summary !== 'string') {
    throw new Error(data.error ?? '図の説明を作れませんでした。')
  }
  return { kind: data.kind ?? 'other', summary: data.summary, detail: data.detail ?? '', bbox: data.bbox ?? null }
}
