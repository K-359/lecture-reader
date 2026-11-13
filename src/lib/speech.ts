/**
 * 読み上げ。2種類の声を切り替えられる。
 * - browser: ブラウザ内蔵の音声合成（Web Speech API）。待ち時間がほぼない
 * - voicevox: API サーバー経由の VOICEVOX。日本語が自然だが、1文ごとに合成の待ちがある
 */

export type VoiceEngine = 'browser' | 'voicevox'

export type SpeakOptions = {
  engine: VoiceEngine
  rate: number
  /** VOICEVOX のスタイル ID */
  speaker: number
  /** 声が出始めたとき */
  onStart?: () => void
  /** 読み終わった、または止めたとき */
  onEnd: () => void
  /** VOICEVOX が使えず、ブラウザの声に切り替えたとき */
  onFallback?: (message: string) => void
}

// ---------- ブラウザの声 ----------

let browserVoice: SpeechSynthesisVoice | null = null

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('ja'))
  // 自然に聞こえることが多い声を優先する
  const preferred = ['Kyoko', 'O-ren', 'Google 日本語', 'Nanami', 'Haruka']
  browserVoice =
    preferred.map((name) => voices.find((v) => v.name.includes(name))).find((v) => v !== undefined) ??
    voices[0] ??
    null
}

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

if (speechSupported) {
  pickVoice()
  speechSynthesis.addEventListener('voiceschanged', pickVoice)
}

// ---------- 共通 ----------

/** 長い文を一度に渡すと途中で止まったり、最初の声が出るまで待たされたりするので、短く区切る */
function splitText(text: string): string[] {
  const sentences = text
    .split(/(?<=[。．！？!?])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  // 長い文は読点で区切る（VOICEVOX は合成に1文字あたり約50ミリ秒かかるため）
  const parts = sentences.flatMap((s) => {
    if (s.length <= 40) return [s]
    const out: string[] = []
    let buf = ''
    for (const piece of s.split(/(?<=[、，,])/)) {
      if (buf && buf.length + piece.length > 40) {
        out.push(buf)
        buf = ''
      }
      buf += piece
    }
    if (buf) out.push(buf)
    return out
  })
  // 声が出るまでの時間は最初のかたまりの長さで決まる。2つ目以降は再生中に合成するので、
  // 最初だけは最初の読点で切って短くする（例:「エントロピーは、」）
  const first = parts[0]
  if (first && first.length > 14) {
    const comma = first.search(/[、，,]/)
    if (comma >= 3 && comma < 20) parts.splice(0, 1, first.slice(0, comma + 1), first.slice(comma + 1))
  }
  return parts.filter((p) => p.trim().length > 0)
}

let session = 0
let audioCtx: AudioContext | null = null
let currentSource: AudioBufferSourceNode | null = null

function getAudioContext(): AudioContext {
  audioCtx ??= new AudioContext()
  return audioCtx
}

/**
 * iOS の Safari では、タップの中で一度音を鳴らしておかないと、
 * 通信を待ってから鳴らした音が出ない。タップのたびに無音を流しておく。
 */
export function unlockSpeech() {
  if (speechSupported) {
    const u = new SpeechSynthesisUtterance('')
    u.volume = 0
    speechSynthesis.speak(u)
  }
  const ctx = getAudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  const silent = ctx.createBufferSource()
  silent.buffer = ctx.createBuffer(1, 1, 22050)
  silent.connect(ctx.destination)
  silent.start()
}

export function stopSpeech() {
  session++
  if (speechSupported) speechSynthesis.cancel()
  currentSource?.stop()
  currentSource = null
}

export function speak(text: string, opts: SpeakOptions) {
  stopSpeech()
  const parts = splitText(text)
  if (parts.length === 0) {
    opts.onEnd()
    return
  }
  if (opts.engine === 'voicevox') void speakVoicevox(parts, opts, session)
  else speakBrowser(parts, opts)
}

function speakBrowser(parts: string[], opts: SpeakOptions) {
  if (!speechSupported) {
    opts.onEnd()
    return
  }
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part)
    u.lang = 'ja-JP'
    if (browserVoice) u.voice = browserVoice
    u.rate = opts.rate
    if (i === 0 && opts.onStart) u.onstart = opts.onStart
    if (i === parts.length - 1) {
      u.onend = opts.onEnd
      u.onerror = opts.onEnd
    }
    speechSynthesis.speak(u)
  })
}

// ---------- VOICEVOX ----------

const MAX_CACHE = 60
const audioCache = new Map<string, Promise<AudioBuffer>>()

/** 同じ文はもう一度合成しない（「もう一度」ボタンや、同じ場所を押し直したとき用） */
function synthesizeCached(text: string, speaker: number, rate: number): Promise<AudioBuffer> {
  const key = `${speaker}|${rate}|${text}`
  const hit = audioCache.get(key)
  if (hit) return hit
  const p = fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker, speed: rate }),
  })
    .then(async (res) => {
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? 'VOICEVOX で音声を作れませんでした。')
      }
      return getAudioContext().decodeAudioData(await res.arrayBuffer())
    })
    .catch((e: unknown) => {
      audioCache.delete(key)
      throw e
    })
  audioCache.set(key, p)
  if (audioCache.size > MAX_CACHE) audioCache.delete(audioCache.keys().next().value!)
  return p
}

function play(buffer: AudioBuffer): Promise<void> {
  return new Promise((resolve) => {
    const ctx = getAudioContext()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => resolve()
    currentSource = source
    source.start()
  })
}

async function speakVoicevox(parts: string[], opts: SpeakOptions, mySession: number) {
  // 今読んでいる文の再生中に、次の文を先に合成しておく
  const pending: (Promise<AudioBuffer> | undefined)[] = []
  const get = (i: number) => (pending[i] ??= synthesizeCached(parts[i], opts.speaker, opts.rate))

  for (let i = 0; i < parts.length; i++) {
    let buffer: AudioBuffer
    try {
      buffer = await get(i)
      if (i + 1 < parts.length) get(i + 1).catch(() => undefined)
    } catch (e) {
      if (mySession !== session) return
      // VOICEVOX が使えないときは、残りをブラウザの声で読む
      opts.onFallback?.(e instanceof Error ? e.message : 'VOICEVOX が使えません。')
      speakBrowser(parts.slice(i), { ...opts, onStart: i === 0 ? opts.onStart : undefined })
      return
    }
    if (mySession !== session) return
    if (i === 0) opts.onStart?.()
    await play(buffer)
    if (mySession !== session) return
  }
  opts.onEnd()
}

// ---------- VOICEVOX の話者一覧 ----------

export type VoicevoxStyle = { id: number; speaker: string; style: string }

export async function fetchVoicevoxStyles(): Promise<VoicevoxStyle[]> {
  const res = await fetch('/api/tts/speakers')
  const data = (await res.json().catch(() => ({}))) as { styles?: VoicevoxStyle[]; error?: string }
  if (!res.ok || !data.styles) throw new Error(data.error ?? 'VOICEVOX の話者一覧を取れませんでした。')
  return data.styles
}
