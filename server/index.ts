import Anthropic from '@anthropic-ai/sdk'
import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { Hono } from 'hono'
import {
  buildExplainPrompt,
  buildReadPrompt,
  EXPLAIN_SCHEMA,
  EXPLAIN_SYSTEM_PROMPT,
  FIGURE_KINDS,
  SYSTEM_PROMPT,
  type ExplainTarget,
  type ReadUnit,
} from './prompt.ts'
import { listStyles, synthesize, VoicevoxUnavailableError } from './voicevox.ts'

// .env の値を、起動元のシェルから引き継いだ環境変数より優先する
config({ override: true })

const PORT = Number(process.env.PORT ?? 8787)
// 読み取りは書き起こしだけなので、速さを優先して Haiku の思考なしを既定にする
const MODEL = process.env.READER_MODEL ?? 'claude-haiku-5-5'
const EFFORT = (process.env.READER_EFFORT ?? 'low') as 'low' | 'medium' | 'high'
// Haiku 5.5 で思考を切れるのは effort が high 以下のとき。Opus 5.5 などは切れないので READER_THINKING=on にする
const THINKING_ON = process.env.READER_THINKING === 'on'

const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
const NO_KEY_MESSAGE = 'APIキーが設定されていません。.env に ANTHROPIC_API_KEY を書いてください。'

const client = new Anthropic()
const app = new Hono()

type ReadRequest = {
  /** ページ全体の画像（JPEG の base64、data URL の接頭辞なし）。クリック位置に印を描いてある */
  pageImage: string
  /** クリック位置の周りを拡大した画像（同上） */
  detailImage: string
  /** クリック位置。ページの左上を (0, 0)、右下を (1, 1) とする */
  x: number
  y: number
  unit: ReadUnit
}

function isReadRequest(body: unknown): body is ReadRequest {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return (
    typeof b.pageImage === 'string' &&
    typeof b.detailImage === 'string' &&
    typeof b.x === 'number' &&
    typeof b.y === 'number' &&
    (b.unit === 'line' || b.unit === 'block')
  )
}

app.get('/api/health', (c) => c.json({ ok: true, model: MODEL }))

// ---------- VOICEVOX ----------

app.get('/api/tts/speakers', async (c) => {
  try {
    return c.json({ styles: await listStyles() })
  } catch (error) {
    if (error instanceof VoicevoxUnavailableError) return c.json({ error: error.message }, 503)
    console.error('[tts] 話者一覧の取得に失敗:', error)
    return c.json({ error: 'VOICEVOX の話者一覧を取れませんでした。' }, 502)
  }
})

app.post('/api/tts', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; speaker?: unknown; speed?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const speaker = typeof body?.speaker === 'number' ? body.speaker : NaN
  const speed = typeof body?.speed === 'number' ? Math.min(2, Math.max(0.5, body.speed)) : 1
  if (!text || text.length > 1000 || !Number.isInteger(speaker)) {
    return c.json({ error: 'リクエストの形式が正しくありません。' }, 400)
  }
  try {
    const startedAt = Date.now()
    const wav = await synthesize(text, speaker, speed, c.req.raw.signal)
    console.log(`[tts] ${Date.now() - startedAt}ms ${text.length}文字`)
    return c.body(wav, 200, { 'Content-Type': 'audio/wav' })
  } catch (error) {
    if (c.req.raw.signal.aborted) return c.body(null, 204) // ブラウザ側が止めたので返す中身はない
    if (error instanceof VoicevoxUnavailableError) return c.json({ error: error.message }, 503)
    console.error('[tts] 音声の合成に失敗:', error)
    return c.json({ error: 'VOICEVOX で音声を作れませんでした。' }, 502)
  }
})

// ---------- VLM での読み取り ----------

app.post('/api/read', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  if (!isReadRequest(body)) {
    return c.json({ error: 'リクエストの形式が正しくありません。' }, 400)
  }

  const startedAt = Date.now()
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: THINKING_ON ? { type: 'adaptive' } : { type: 'disabled' },
      output_config: { effort: EFFORT },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            imageBlock(body.pageImage),
            imageBlock(body.detailImage),
            { type: 'text', text: buildReadPrompt(body.x, body.y, body.unit) },
          ],
        },
      ],
    })

    if (response.stop_reason === 'refusal') {
      return c.json({ error: 'この部分は読み取れませんでした。' }, 422)
    }

    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim()

    console.log(
      `[read] ${Date.now() - startedAt}ms model=${response.model} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
    )
    return c.json({ text })
  } catch (error) {
    return c.json(...apiErrorResponse('read', error))
  }
})

/** Claude API のエラーを、画面に出す日本語のメッセージと HTTP の状態コードにする */
function apiErrorResponse(tag: string, error: unknown): [{ error: string }, 429 | 500 | 502] {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error(`[${tag}] 認証エラー:`, error.message)
    return [{ error: 'APIキーが設定されていないか、正しくありません。' }, 500]
  }
  if (error instanceof Anthropic.RateLimitError) {
    return [{ error: '混み合っています。少し待ってからもう一度押してください。' }, 429]
  }
  if (error instanceof Anthropic.APIError) {
    console.error(`[${tag}] APIエラー ${error.status}:`, error.message)
    return [{ error: '読み取りに失敗しました。' }, 502]
  }
  if (!hasCredentials) {
    console.error(`[${tag}] ${NO_KEY_MESSAGE}`)
    return [{ error: NO_KEY_MESSAGE }, 500]
  }
  console.error(`[${tag}] 予期しないエラー:`, error)
  return [{ error: '読み取りに失敗しました。' }, 500]
}

function imageBlock(data: string): Anthropic.ImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }
}

// ---------- 図の説明 ----------

type ExplainRequest = { pageImage: string; detailImage: string; target: ExplainTarget }

const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1

function isExplainTarget(t: unknown): t is ExplainTarget {
  if (typeof t !== 'object' || t === null) return false
  const o = t as Record<string, unknown>
  if (o.type === 'point') return isUnit(o.x) && isUnit(o.y)
  if (o.type === 'rect') {
    return isUnit(o.left) && isUnit(o.top) && isUnit(o.right) && isUnit(o.bottom) && o.left < o.right && o.top < o.bottom
  }
  return false
}

function isExplainRequest(body: unknown): body is ExplainRequest {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return typeof b.pageImage === 'string' && typeof b.detailImage === 'string' && isExplainTarget(b.target)
}

type Explanation = {
  kind: (typeof FIGURE_KINDS)[number]
  summary: string
  detail: string
  bbox: { left: number; top: number; right: number; bottom: number } | null
}

/** モデルの返した JSON を確かめて整える。範囲がおかしければ null にする */
function toExplanation(raw: unknown, target: ExplainTarget): Explanation | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.summary !== 'string' || typeof r.detail !== 'string') return null
  const kind = FIGURE_KINDS.find((k) => k === r.kind) ?? 'other'
  let bbox: Explanation['bbox'] = null
  if (target.type === 'rect') {
    // 範囲を選んだときは、選んだ範囲をそのまま枠にする
    bbox = { left: target.left, top: target.top, right: target.right, bottom: target.bottom }
  } else if (Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((v) => typeof v === 'number')) {
    const [l, t, rt, b] = (r.bbox as number[]).map((v) => Math.min(1, Math.max(0, v)))
    if (rt - l > 0.02 && b - t > 0.02) bbox = { left: l, top: t, right: rt, bottom: b }
  }
  return { kind, summary: r.summary.trim(), detail: r.detail.trim(), bbox }
}

app.post('/api/explain', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  if (!isExplainRequest(body)) {
    return c.json({ error: 'リクエストの形式が正しくありません。' }, 400)
  }

  const startedAt = Date.now()
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: THINKING_ON ? { type: 'adaptive' } : { type: 'disabled' },
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: EXPLAIN_SCHEMA } },
      system: EXPLAIN_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            imageBlock(body.pageImage),
            imageBlock(body.detailImage),
            { type: 'text', text: buildExplainPrompt(body.target) },
          ],
        },
      ],
    })

    if (response.stop_reason === 'refusal') {
      return c.json({ error: 'この部分は説明できませんでした。' }, 422)
    }
    const json = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    let parsed: unknown = null
    try {
      parsed = JSON.parse(json)
    } catch {
      // max_tokens で途切れたときなど
    }
    const explanation = toExplanation(parsed, body.target)
    console.log(
      `[explain] ${Date.now() - startedAt}ms ${body.target.type} model=${response.model} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
    )
    if (!explanation) {
      console.error('[explain] 返事の形が正しくありません:', json.slice(0, 200))
      return c.json({ error: '図の説明を作れませんでした。' }, 502)
    }
    return c.json(explanation)
  } catch (error) {
    return c.json(...apiErrorResponse('explain', error))
  }
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`API server: http://localhost:${info.port} (model: ${MODEL}, effort: ${EFFORT}, thinking: ${THINKING_ON ? 'on' : 'off'})`)
  if (!hasCredentials) console.warn(`⚠ ${NO_KEY_MESSAGE}`)
})
