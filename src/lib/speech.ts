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

/**
 * VOICEVOX でかたまりを切ってよい助詞（は・が・を・に・で・も・と・の）。
 * 「では」「ときに」のような言い回しの中で切らないよう、前後が漢字・カタカナ（後ろは数字も可）のところに限る。
 * 例: 「エントロピーは｜情報量の…」「レポートの｜締め切りは…」
 */
const SPLIT_PARTICLE = /(?<=[\u4e00-\u9fff\u30a0-\u30ff])[はがをにでもとの](?=[\u4e00-\u9fff\u30a0-\u30ff0-9])/g
const COMMA = /[、，,]/g

/** VOICEVOX で2つ目以降のかたまりの長さの目安。続けてクリックしたとき、作りかけの音声を待つ時間がこれで決まる */
const MAX_CHUNK = 16
/** 切った後に残る部分の最小の長さ（「です」だけのような細切れにしない） */
const MIN_PIECE = 3

/** 切れ目（読点か助詞の直後）の位置を、前から順に返す。読点を先に探す */
function cutPoints(s: string): { comma: number[]; particle: number[] } {
  const ok = (e: number) => e >= MIN_PIECE + 1 && s.length - e >= MIN_PIECE
  return {
    comma: [...s.matchAll(COMMA)].map((m) => m.index + 1).filter(ok),
    particle: [...s.matchAll(SPLIT_PARTICLE)].map((m) => m.index + 1).filter(ok),
  }
}

/** 最初のかたまりはできるだけ早く鳴らしたいので、14文字以内で一番前の切れ目で切る */
function splitFirstChunk(first: string): string[] {
  if (first.length <= 8) return [first]
  const { comma, particle } = cutPoints(first)
  const cut = comma.find((e) => e < 20) ?? particle.find((e) => e <= 14)
  return cut ? [first.slice(0, cut), first.slice(cut)] : [first]
}

/** 2つ目以降は MAX_CHUNK 文字以内の一番後ろの切れ目で切る（切れ目を増やしすぎないため）。なければその先の最初の切れ目 */
function splitShort(s: string): string[] {
  const out: string[] = []
  let rest = s
  while (rest.length > MAX_CHUNK) {
    const { comma, particle } = cutPoints(rest)
    const within = (list: number[]) => list.filter((e) => e <= MAX_CHUNK).at(-1)
    const cut = within(comma) ?? within(particle) ?? [...comma, ...particle].sort((a, b) => a - b)[0]
    if (!cut) break
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  out.push(rest)
  return out
}

/**
 * 長い文を一度に渡すと途中で止まったり、最初の声が出るまで待たされたりするので、短く区切る。
 * voicevox: VOICEVOX は1文字あたり約50ミリ秒かけて合成してから鳴らすので、さらに短く切る。
 * 声が出るまでの時間は最初のかたまりの長さで、続けてクリックしたときの待ちは作りかけのかたまりの長さで決まる。
 * （ブラウザの声では不要な間ができるだけなので切らない）
 */
function splitText(text: string, voicevox: boolean): string[] {
  const sentences = text
    .split(/(?<=[。．！？!?])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  // 長い文は読点で区切る
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
  if (!voicevox) return parts
  if (parts.length > 0) parts.splice(0, 1, ...splitFirstChunk(parts[0]))
  return parts.flatMap(splitShort).filter((p) => p.trim().length > 0)
}

let session = 0
/** 読み上げを止めたら、まだ返ってきていない VOICEVOX への依頼も取り消す */
let sessionAbort = new AbortController()
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
  sessionAbort.abort()
  sessionAbort = new AbortController()
  if (speechSupported) speechSynthesis.cancel()
  currentSource?.stop()
  currentSource = null
}

export function speak(text: string, opts: SpeakOptions) {
  stopSpeech()
  const parts = splitText(text, opts.engine === 'voicevox')
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
function synthesizeCached(text: string, speaker: number, rate: number, signal: AbortSignal): Promise<AudioBuffer> {
  const key = `${speaker}|${rate}|${text}`
  const hit = audioCache.get(key)
  if (hit) return hit
  const p = fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker, speed: rate }),
    signal,
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
  const signal = sessionAbort.signal
  const get = (i: number) => (pending[i] ??= synthesizeCached(parts[i], opts.speaker, opts.rate, signal))

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
