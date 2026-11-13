/**
 * 音声合成が読み飛ばしたり変に読んだりしやすい記号を、読み方に置き換える。
 * 画面には元の文字をそのまま出し、読み上げるときだけこれを通す。
 * （VLM の結果はすでに読み方に直っているので、通しても変わらない）
 */

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'
const SUPERSCRIPT: Record<string, string> = { '²': 'の2乗', '³': 'の3乗', 'ⁿ': 'のエヌ乗' }

const SYMBOLS: [RegExp, string][] = [
  [/≠/g, ' ノットイコール '],
  [/[≦≤]/g, ' 以下 '],
  [/[≧≥]/g, ' 以上 '],
  [/≈/g, ' ニアリーイコール '],
  [/=/g, ' イコール '],
  [/±/g, ' プラスマイナス '],
  [/−/g, ' マイナス '], // 数式のマイナス記号（ハイフンではない）
  [/×/g, ' かける '],
  [/÷/g, ' 割る '],
  [/[→⇒]/g, ' から '],
  [/[∑Σ]/g, ' シグマ '],
  [/√/g, ' ルート '],
  [/∞/g, ' 無限大 '],
  [/∫/g, ' インテグラル '],
  [/∈/g, ' 属する '],
  [/[<＜]/g, ' 小なり '],
  [/[>＞]/g, ' 大なり '],
]

export function toSpeakable(text: string): string {
  let out = text.replace(/[₀-₉]/g, (c) => String(SUBSCRIPT.indexOf(c)))
  out = out.replace(/[²³ⁿ]/g, (c) => SUPERSCRIPT[c])
  for (const [re, word] of SYMBOLS) out = out.replace(re, word)
  return out.replace(/\s+/g, ' ').trim()
}
