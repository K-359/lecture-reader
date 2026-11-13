# 講義資料よみあげ（lecture-reader）

LHON（レーベル遺伝性視神経症）などで講義資料が見えにくい学生のための Web アプリです。
講義資料の PDF を開き、読みたい場所をクリック（タブレットではタップ）すると、その部分の文字を読み上げます。

## しくみ

1. ブラウザで PDF を表示する（pdf.js）
2. クリックした位置に印を付けた画像を2枚作る（ページ全体と、周りの拡大）
3. API サーバー経由で Claude（VLM）に送り、印の位置の文字を書き起こしてもらう
4. 書き起こした文字を画面下に大きく表示し、ブラウザの音声合成（Web Speech API）で読み上げる

読む範囲は「まとまり」（箇条書きの1項目・段落など）と「1行」を切り替えられます。

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
  - `lib/capture.ts` VLM に送る画像の切り出し
  - `lib/speech.ts` 読み上げ
- `server/` … API サーバー（Hono）。API キーをブラウザに渡さないために Claude の呼び出しはここで行う
  - `prompt.ts` 読み取りの指示文

## 設定（.env）

| 変数 | 既定値 | 内容 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API のキー |
| `READER_MODEL` | `claude-opus-5-5` | 読み取りに使うモデル |
| `READER_EFFORT` | `low` | 思考の深さ（`low` / `medium` / `high`） |
| `PORT` | `8787` | API サーバーのポート |
