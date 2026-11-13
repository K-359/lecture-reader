# 講義資料よみあげ（lecture-reader）

LHON（レーベル遺伝性視神経症）などで講義資料が見えにくい学生のための Web アプリです。
講義資料の PDF を開き、読みたい場所をクリック（タブレットではタップ）すると、その部分の文字を読み上げます。

## しくみ

クリックした場所の文字は、次の順に取り出します（「自動」のとき）。

1. **PDF の文字データ**（pdf.js）から、クリック位置の行・まとまりを探す。VLM を通さないので一瞬で返る
2. 文字データがない（スキャンした PDF）、文字化けしている、図や空白の上をクリックした、のどれかなら **VLM（Claude）** に回す。
   クリック位置に印を付けた画像（ページ全体と周りの拡大）を API サーバー経由で送り、書き起こしてもらう

取り出した文字は画面下に大きく表示し、読んでいる範囲をページ上で黄色く囲みます。
読み上げはブラウザの音声合成（Web Speech API）です。`=` や `≦` などの記号は読み方に直してから読みます。

- 読む範囲：「まとまり」（箇条書きの1項目・段落など）／「1行」
- 読み取り方：「自動」（文字データ優先）／「AI」（いつも VLM）

## 使い方

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY を書く
npm run dev
```

- PC: http://localhost:5175
- タブレット（同じ Wi-Fi）: ターミナルに出る `Network:` の URL

`samples/sample.pdf` は動作確認用のスライドです。

## 構成

- `src/` … フロントエンド（React + Vite）
  - `lib/pdf.ts` PDF の読み込みと描画
  - `lib/textLayer.ts` PDF の文字データから行・まとまりを取り出す
  - `lib/speechText.ts` 記号を読み方に直す
  - `lib/capture.ts` VLM に送る画像の切り出し
  - `lib/speech.ts` 読み上げ
- `server/` … API サーバー（Hono）。API キーをブラウザに渡さないために Claude の呼び出しはここで行う
  - `prompt.ts` 読み取りの指示文

## 設定（.env）

| 変数 | 既定値 | 内容 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API のキー |
| `READER_MODEL` | `claude-haiku-5-5` | 読み取りに使うモデル |
| `READER_EFFORT` | `low` | effort（`low` / `medium` / `high`） |
| `READER_THINKING` | `off` | 思考の有無。思考を切れないモデル（`claude-opus-5-5` など）では `on` にする |
| `PORT` | `8787` | API サーバーのポート |
