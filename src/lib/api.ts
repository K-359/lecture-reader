import type { CapturedImages } from './capture'

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
