/**
 * VOICEVOX エンジン（既定は http://localhost:50021）への中継。
 * ブラウザから直接つながず API サーバーを通すことで、タブレットからでも PC の VOICEVOX を使える。
 */

const VOICEVOX_URL = (process.env.VOICEVOX_URL ?? 'http://localhost:50021').replace(/\/$/, '')

export const VOICEVOX_DOWN_MESSAGE = 'VOICEVOX につながりません。VOICEVOX を起動してください。'

export class VoicevoxUnavailableError extends Error {}

type SpeakerResponse = {
  name: string
  styles: { name: string; id: number; type?: string }[]
}[]

export type VoicevoxStyle = { id: number; speaker: string; style: string }

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${VOICEVOX_URL}${path}`, { ...init, signal: AbortSignal.timeout(15000) })
  } catch {
    throw new VoicevoxUnavailableError(VOICEVOX_DOWN_MESSAGE)
  }
  if (!res.ok) throw new Error(`VOICEVOX ${path} が ${res.status} を返しました`)
  return res
}

/** 話者とスタイルの一覧（歌唱用のスタイルは除く） */
export async function listStyles(): Promise<VoicevoxStyle[]> {
  const speakers = (await (await call('/speakers')).json()) as SpeakerResponse
  return speakers.flatMap((sp) =>
    sp.styles
      .filter((st) => st.type === undefined || st.type === 'talk')
      .map((st) => ({ id: st.id, speaker: sp.name, style: st.name })),
  )
}

/** 文章を WAV にする */
export async function synthesize(text: string, speaker: number, speed: number): Promise<ArrayBuffer> {
  const params = new URLSearchParams({ text, speaker: String(speaker) })
  const query = (await (await call(`/audio_query?${params}`, { method: 'POST' })).json()) as Record<string, unknown>
  query.speedScale = speed
  // 文の前後の無音を短くして、文と文の間の待ちを減らす（既定は 0.1 秒）
  query.prePhonemeLength = 0.05
  query.postPhonemeLength = 0.05
  const wav = await call(`/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  })
  return wav.arrayBuffer()
}
