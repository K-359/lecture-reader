import Anthropic from '@anthropic-ai/sdk'
import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { Hono } from 'hono'
import { buildReadPrompt, SYSTEM_PROMPT, type ReadUnit } from './prompt.ts'
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
    const wav = await synthesize(text, speaker, speed)
    console.log(`[tts] ${Date.now() - startedAt}ms ${text.length}文字`)
    return c.body(wav, 200, { 'Content-Type': 'audio/wav' })
  } catch (error) {
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
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: body.pageImage },
            },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: body.detailImage },
            },
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
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('[read] 認証エラー:', error.message)
      return c.json({ error: 'APIキーが設定されていないか、正しくありません。' }, 500)
    }
    if (error instanceof Anthropic.RateLimitError) {
      return c.json({ error: '混み合っています。少し待ってからもう一度押してください。' }, 429)
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`[read] APIエラー ${error.status}:`, error.message)
      return c.json({ error: '読み取りに失敗しました。' }, 502)
    }
    if (!hasCredentials) {
      console.error(`[read] ${NO_KEY_MESSAGE}`)
      return c.json({ error: NO_KEY_MESSAGE }, 500)
    }
    console.error('[read] 予期しないエラー:', error)
    return c.json({ error: '読み取りに失敗しました。' }, 500)
  }
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`API server: http://localhost:${info.port} (model: ${MODEL}, effort: ${EFFORT}, thinking: ${THINKING_ON ? 'on' : 'off'})`)
  if (!hasCredentials) console.warn(`⚠ ${NO_KEY_MESSAGE}`)
})
