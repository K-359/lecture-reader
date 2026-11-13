import Anthropic from '@anthropic-ai/sdk'
import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { Hono } from 'hono'
import { buildReadPrompt, SYSTEM_PROMPT, type ReadUnit } from './prompt.ts'

// .env の値を、起動元のシェルから引き継いだ環境変数より優先する
config({ override: true })

const PORT = Number(process.env.PORT ?? 8787)
const MODEL = process.env.READER_MODEL ?? 'claude-opus-5-5'
const EFFORT = (process.env.READER_EFFORT ?? 'low') as 'low' | 'medium' | 'high'

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

app.post('/api/read', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  if (!isReadRequest(body)) {
    return c.json({ error: 'リクエストの形式が正しくありません。' }, 400)
  }

  const startedAt = Date.now()
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      // 安全分類器に断られたときは、サーバー側で別のモデルに自動で切り替える
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
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
  console.log(`API server: http://localhost:${info.port} (model: ${MODEL}, effort: ${EFFORT})`)
  if (!hasCredentials) console.warn(`⚠ ${NO_KEY_MESSAGE}`)
})
