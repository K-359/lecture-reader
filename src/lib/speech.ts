/**
 * ブラウザ内蔵の音声合成（Web Speech API）で日本語を読み上げる。
 * まずは追加の費用がかからないこの方式にしておき、声の質が足りなければ外部の TTS に置き換える。
 */

let voice: SpeechSynthesisVoice | null = null

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('ja'))
  // 自然に聞こえることが多い声を優先する
  const preferred = ['Kyoko', 'O-ren', 'Google 日本語', 'Nanami', 'Haruka']
  voice =
    preferred.map((name) => voices.find((v) => v.name.includes(name))).find((v) => v !== undefined) ??
    voices[0] ??
    null
}

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

if (speechSupported) {
  pickVoice()
  speechSynthesis.addEventListener('voiceschanged', pickVoice)
}

/**
 * iOS の Safari では、ユーザーの操作の中で一度 speak しておかないと、
 * その後に（通信を待ってから）呼んだ speak が鳴らない。タップのたびに空の発話を流しておく。
 */
export function unlockSpeech() {
  if (!speechSupported) return
  const u = new SpeechSynthesisUtterance('')
  u.volume = 0
  speechSynthesis.speak(u)
}

/** 長い文を一度に渡すと途中で止まるブラウザがあるので、文ごとに分けて順に読む */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。．！？!?])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function speak(text: string, rate: number, onEnd: () => void) {
  if (!speechSupported) {
    onEnd()
    return
  }
  speechSynthesis.cancel()
  const parts = splitSentences(text)
  if (parts.length === 0) {
    onEnd()
    return
  }
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part)
    u.lang = 'ja-JP'
    if (voice) u.voice = voice
    u.rate = rate
    if (i === parts.length - 1) {
      u.onend = onEnd
      u.onerror = onEnd
    }
    speechSynthesis.speak(u)
  })
}

export function stopSpeech() {
  if (speechSupported) speechSynthesis.cancel()
}
