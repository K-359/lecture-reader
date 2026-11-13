import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { explainAt, readAt, type ExplainTarget } from './lib/api'
import { captureAround, captureRegion } from './lib/capture'
import { figureAt, prefetchFigures } from './lib/figures'
import { isCancelled, openPdf, pageAspect, renderPage, type PDFDocumentProxy, type PDFPageProxy } from './lib/pdf'
import {
  fetchVoicevoxStyles,
  speak,
  speechSupported,
  stopSpeech,
  unlockSpeech,
  type VoiceEngine,
  type VoicevoxStyle,
} from './lib/speech'
import { toSpeakable } from './lib/speechText'
import { findTextAt, pageHasText, prefetchText, type Box } from './lib/textLayer'
import './App.css'

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'speaking' }
  | { kind: 'error'; message: string }

type Source = 'pdf' | 'ai' | 'figure'

/** 説明した図。同じ図をもう一度押すか「くわしく」で detail を読む */
type Figure = { pageNumber: number; box: Box | null; summary: string; detail: string; showing: 'summary' | 'detail' }

/** これより動かしたらクリックではなく範囲選択とみなす（CSS ピクセル） */
const DRAG_THRESHOLD = 10

function inside(b: Box, x: number, y: number) {
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom
}

/** 2点を対角とする範囲（ページに対する 0〜1 の割合） */
function boxFrom(rect: DOMRect, x0: number, y0: number, x1: number, y1: number): Box {
  const nx = (v: number) => Math.min(1, Math.max(0, (v - rect.left) / rect.width))
  const ny = (v: number) => Math.min(1, Math.max(0, (v - rect.top) / rect.height))
  return {
    left: Math.min(nx(x0), nx(x1)),
    right: Math.max(nx(x0), nx(x1)),
    top: Math.min(ny(y0), ny(y1)),
    bottom: Math.max(ny(y0), ny(y1)),
  }
}

/** 100% = ページ全体が画面に収まる大きさ */
const ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3]
const RATE_MIN = 0.6
const RATE_MAX = 2

function loadNumber(key: string, fallback: number) {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [fileName, setFileName] = useState('')
  const [pageNumber, setPageNumber] = useState(1)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [zoomIndex, setZoomIndex] = useState(3)
  const [rate, setRate] = useState(() => loadNumber('rate', 1))
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ source: Source; ms: number } | null>(null)
  /** クリックしてから声が出始めるまでの時間 */
  const [voiceMs, setVoiceMs] = useState<number | null>(null)
  const [engine, setEngine] = useState<VoiceEngine>(() =>
    localStorage.getItem('engine') === 'voicevox' ? 'voicevox' : 'browser',
  )
  const [speaker, setSpeaker] = useState(() => loadNumber('speaker', 2))
  const [styles, setStyles] = useState<VoicevoxStyle[]>([])
  const [voiceNotice, setVoiceNotice] = useState('')
  const [highlights, setHighlights] = useState<Box[]>([])
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null)
  const [figure, setFigure] = useState<Figure | null>(null)
  /** ドラッグで選んでいる範囲 */
  const [selection, setSelection] = useState<Box | null>(null)
  const [dragging, setDragging] = useState(false)
  const [viewerSize, setViewerSize] = useState({ width: 0, height: 0 })
  /** 上の操作バーと下の読み取り欄を隠して、PDF を広く見せる */
  const [chromeHidden, setChromeHidden] = useState(false)

  const viewerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const dragRef = useRef<{ id: number; x0: number; y0: number; active: boolean } | null>(null)
  /** ドラッグを終えた直後の click は、クリックとして扱わない */
  const suppressClickRef = useRef(false)

  useEffect(() => localStorage.setItem('rate', String(rate)), [rate])
  useEffect(() => localStorage.setItem('engine', engine), [engine])
  useEffect(() => localStorage.setItem('speaker', String(speaker)), [speaker])

  // VOICEVOX を選んだら話者の一覧を取る
  useEffect(() => {
    if (engine !== 'voicevox') return
    let alive = true
    fetchVoicevoxStyles()
      .then((list) => {
        if (!alive) return
        setStyles(list)
        setVoiceNotice('')
      })
      .catch((e: unknown) => alive && setVoiceNotice(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [engine])

  // 表示領域の大きさに合わせてページを描くため、大きさの変化を見張る
  useEffect(() => {
    const el = viewerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) =>
      setViewerSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const loadFile = useCallback(async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setStatus({ kind: 'error', message: 'PDFファイルを選んでください。' })
      return
    }
    try {
      const next = await openPdf(file)
      setDoc((prev) => {
        void prev?.loadingTask.destroy()
        return next
      })
      setFileName(file.name)
      setPageNumber(1)
      setMarker(null)
      setHighlights([])
      setFigure(null)
      setSelection(null)
      setResult(null)
      setText('')
      setStatus({ kind: 'idle' })
    } catch {
      setStatus({ kind: 'error', message: 'PDFを開けませんでした。' })
    }
  }, [])

  // ページを取り出す
  useEffect(() => {
    if (!doc) return
    let alive = true
    void doc.getPage(pageNumber).then((p) => {
      if (!alive) return
      prefetchText(p)
      prefetchFigures(p)
      setPage(p)
    })
    return () => {
      alive = false
    }
  }, [doc, pageNumber])

  // ページを描く。100% のときはページ全体が表示領域にちょうど収まる大きさ。画素数は画面の解像度に合わせる
  const aspect = page ? pageAspect(page) : 1.414
  const fitWidth = Math.min(viewerSize.width, viewerSize.height / aspect)
  const cssWidth = Math.max(200, Math.floor(fitWidth * ZOOM_STEPS[zoomIndex]))
  const cssHeight = Math.floor(cssWidth * aspect)
  const pageFits = cssWidth <= viewerSize.width + 1 && cssHeight <= viewerSize.height + 1
  const viewerWidth = viewerSize.width
  useEffect(() => {
    const canvas = canvasRef.current
    if (!page || !canvas || viewerWidth === 0) return
    const task = renderPage(page, canvas, cssWidth * (window.devicePixelRatio || 1))
    task.promise.catch((e: unknown) => {
      if (!isCancelled(e)) setStatus({ kind: 'error', message: 'ページを表示できませんでした。' })
    })
    return () => task.cancel()
  }, [page, cssWidth, viewerWidth])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    stopSpeech()
    setStatus({ kind: 'idle' })
  }, [])

  const say = useCallback(
    (t: string, startedAt = performance.now()) => {
      setStatus({ kind: 'speaking' })
      setVoiceMs(null)
      setVoiceNotice('')
      speak(toSpeakable(t), {
        engine,
        rate,
        speaker,
        onStart: () => setVoiceMs(performance.now() - startedAt),
        onEnd: () => setStatus((s) => (s.kind === 'speaking' ? { kind: 'idle' } : s)),
        onFallback: (message) => setVoiceNotice(`${message}（ブラウザの声で読みます）`),
      })
    },
    [engine, rate, speaker],
  )

  /** 前の読み取りと読み上げを止めて、新しい読み取りを始める */
  const begin = () => {
    unlockSpeech()
    abortRef.current?.abort()
    stopSpeech()
    const controller = new AbortController()
    abortRef.current = controller
    setVoiceMs(null)
    setStatus({ kind: 'reading' })
    return { controller, startedAt: performance.now() }
  }

  const fail = (controller: AbortController, err: unknown) => {
    if (controller.signal.aborted) return
    setStatus({ kind: 'error', message: err instanceof Error ? err.message : '読み取りに失敗しました。' })
  }

  /** 図を説明させ、まずひとこと（summary）を読む */
  const explain = async (
    p: PDFPageProxy,
    target: ExplainTarget,
    controller: AbortController,
    startedAt: number,
    /** PDF から推定した図の範囲。あればモデルの返す範囲より正確なので、こちらで囲む */
    region: Box | null = null,
  ) => {
    const images = target.type === 'point' ? await captureAround(p, target.x, target.y) : await captureRegion(p, target)
    const ex = await explainAt(images, target, controller.signal)
    if (controller.signal.aborted) return
    const box = target.type === 'point' ? (region ?? ex.bbox) : ex.bbox
    setFigure(ex.detail ? { pageNumber, box, summary: ex.summary, detail: ex.detail, showing: 'summary' } : null)
    setSelection(null)
    setHighlights(box ? [box] : [])
    setText(ex.summary)
    setResult({ source: 'figure', ms: performance.now() - startedAt })
    say(ex.summary, startedAt)
  }

  /** 説明した図の、くわしい説明を読む */
  const showDetail = (f: Figure, startedAt = performance.now()) => {
    setFigure({ ...f, showing: 'detail' })
    setMarker(null)
    setSelection(null)
    setHighlights(f.box ? [f.box] : [])
    setText(f.detail)
    say(f.detail, startedAt)
  }

  const onDetailButton = () => {
    if (!figure) return
    unlockSpeech()
    abortRef.current?.abort()
    showDetail(figure)
  }

  const onPageClick = async (e: MouseEvent<HTMLCanvasElement>) => {
    if (!page) return
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    const { controller, startedAt } = begin()
    setMarker({ x, y })
    setHighlights([])
    setSelection(null)
    try {
      // 押した場所が図の中か（図の中のラベルを押したときも、図の説明にする）
      const region = await figureAt(page, x, y)
      if (controller.signal.aborted) return
      // 図の外なら、PDF の文字データからまとまりを探して読む（一瞬で返る）
      if (!region) {
        const hit = await findTextAt(page, x, y, 'block').catch(() => null)
        if (controller.signal.aborted) return
        if (hit) {
          setFigure(null)
          setText(hit.text)
          setHighlights(hit.boxes)
          setResult({ source: 'pdf', ms: performance.now() - startedAt })
          say(hit.text, startedAt)
          return
        }
      }
      // 説明したばかりの図をもう一度押したら、くわしい説明を読む
      if (figure?.pageNumber === pageNumber && figure.showing === 'summary' && figure.box && inside(figure.box, x, y)) {
        showDetail(figure, startedAt)
        return
      }
      // 図の上、または文字データのあるページで文字のない場所を押したときは、図を説明する
      if (region || (await pageHasText(page).catch(() => false))) {
        if (controller.signal.aborted) return
        await explain(page, { type: 'point', x, y }, controller, startedAt, region)
        return
      }
      // 文字データがない（スキャンした）PDF や、文字化けしているときは VLM で書き起こす
      const images = await captureAround(page, x, y)
      const read = await readAt(images, x, y, 'block', controller.signal)
      if (controller.signal.aborted) return
      setFigure(null)
      setText(read)
      setResult({ source: 'ai', ms: performance.now() - startedAt })
      say(read, startedAt)
    } catch (err) {
      fail(controller, err)
    }
  }

  // ---------- ドラッグで範囲を選ぶ ----------
  // マウスはいつでも。タッチは、ページが画面に収まっていてスクロールの必要がないときだけ
  // （拡大してはみ出しているときは、指のドラッグをスクロールに使う）

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    suppressClickRef.current = false
    if (!page || e.button !== 0) return
    if (e.pointerType !== 'mouse' && !pageFits) return
    dragRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, active: false }
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return
      d.active = true
      e.currentTarget.setPointerCapture(e.pointerId)
      setMarker(null)
      setHighlights([])
    }
    setSelection(boxFrom(e.currentTarget.getBoundingClientRect(), d.x0, d.y0, e.clientX, e.clientY))
  }

  const onPointerUp = async (e: PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!page || !d?.active || d.id !== e.pointerId) return
    suppressClickRef.current = true
    const box = boxFrom(e.currentTarget.getBoundingClientRect(), d.x0, d.y0, e.clientX, e.clientY)
    setSelection(box)
    const { controller, startedAt } = begin()
    try {
      await explain(page, { type: 'rect', ...box }, controller, startedAt)
    } catch (err) {
      fail(controller, err)
    }
  }

  const onPointerCancel = () => {
    if (dragRef.current?.active) setSelection(null)
    dragRef.current = null
  }

  const numPages = doc?.numPages ?? 0
  const goTo = useCallback(
    (n: number) => {
      if (n < 1 || n > numPages) return
      stop()
      setMarker(null)
      setHighlights([])
      setFigure(null)
      setSelection(null)
      setPageNumber(n)
      viewerRef.current?.scrollTo({ top: 0 })
    },
    [numPages, stop],
  )

  // キーボード: スペースでメニューを出し入れ、←→ でページ移動、Esc で読み上げを止める
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement) return
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault()
        // ボタンにフォーカスがあると、スペースでそのボタンも押されてしまうので外す
        if (e.target instanceof HTMLElement) e.target.blur()
        setChromeHidden((h) => !h)
        return
      }
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(pageNumber - 1)
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(pageNumber + 1)
      else if (e.key === 'Escape') stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, pageNumber, stop])

  const busy = status.kind === 'reading' || status.kind === 'speaking'

  return (
    <div
      className={`app ${chromeHidden ? 'chrome-hidden' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file) void loadFile(file)
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void loadFile(file)
          e.target.value = ''
        }}
      />

      {!chromeHidden && (
        <header className="toolbar">
          <button type="button" className="btn primary" onClick={() => fileInputRef.current?.click()}>
            PDFを開く
          </button>

          {doc && (
            <>
              <div className="group" role="group" aria-label="ページ">
                <button type="button" className="btn" onClick={() => goTo(pageNumber - 1)} disabled={pageNumber <= 1}>
                  ◀ 前
                </button>
                <span className="page-count" aria-live="polite">
                  {pageNumber} / {numPages}
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => goTo(pageNumber + 1)}
                  disabled={pageNumber >= numPages}
                >
                  次 ▶
                </button>
              </div>

              <div className="group" role="group" aria-label="表示の大きさ">
                <button
                  type="button"
                  className="btn"
                  aria-label="小さく表示"
                  onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
                  disabled={zoomIndex === 0}
                >
                  －
                </button>
                <span className="zoom">{Math.round(ZOOM_STEPS[zoomIndex] * 100)}%</span>
                <button
                  type="button"
                  className="btn"
                  aria-label="大きく表示"
                  onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
                  disabled={zoomIndex === ZOOM_STEPS.length - 1}
                >
                  ＋
                </button>
              </div>
            </>
          )}

          <div className="group" role="group" aria-label="声">
            <button
              type="button"
              className={`btn toggle ${engine === 'browser' ? 'on' : ''}`}
              aria-pressed={engine === 'browser'}
              onClick={() => setEngine('browser')}
            >
              標準の声
            </button>
            <button
              type="button"
              className={`btn toggle ${engine === 'voicevox' ? 'on' : ''}`}
              aria-pressed={engine === 'voicevox'}
              onClick={() => setEngine('voicevox')}
            >
              VOICEVOX
            </button>
            {engine === 'voicevox' && styles.length > 0 && (
              <select
                className="select"
                aria-label="VOICEVOX の話者"
                value={speaker}
                onChange={(e) => setSpeaker(Number(e.target.value))}
              >
                {styles.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.speaker}（{st.style}）
                  </option>
                ))}
              </select>
            )}
          </div>

          <label className="rate">
            <span>速さ {rate.toFixed(1)}</span>
            <input
              type="range"
              min={RATE_MIN}
              max={RATE_MAX}
              step={0.1}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </label>

          <button type="button" className="btn hide-chrome" onClick={() => setChromeHidden(true)}>
            隠す（スペース）
          </button>
        </header>
      )}

      {chromeHidden && (
        <div className="floating">
          {status.kind === 'error' && <span className="badge error">{status.message}</span>}
          {figure?.showing === 'summary' && (
            <button type="button" className="btn" onClick={onDetailButton}>
              くわしく
            </button>
          )}
          {busy && (
            <button type="button" className="btn stop" onClick={stop}>
              ■ 止める
            </button>
          )}
          <button type="button" className="btn" onClick={() => setChromeHidden(false)}>
            メニュー（スペース）
          </button>
        </div>
      )}

      <main ref={viewerRef} className={`viewer ${dragging ? 'dragging' : ''}`}>
        {doc ? (
          <div className="page" style={{ width: cssWidth, height: cssHeight }}>
            <canvas
              ref={canvasRef}
              className={`page-canvas ${pageFits ? 'touch-select' : ''}`}
              style={{ width: cssWidth, height: cssHeight }}
              onClick={onPageClick}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              aria-label={`${fileName} の ${pageNumber} ページ目。読みたい場所をクリックしてください`}
            />
            {highlights.map((b, i) => (
              <div
                key={i}
                className="highlight"
                style={{
                  left: `${b.left * 100}%`,
                  top: `${b.top * 100}%`,
                  width: `${(b.right - b.left) * 100}%`,
                  height: `${(b.bottom - b.top) * 100}%`,
                }}
                aria-hidden="true"
              />
            ))}
            {selection && (
              <div
                className={`selection ${status.kind === 'reading' ? 'pulse' : ''}`}
                style={{
                  left: `${selection.left * 100}%`,
                  top: `${selection.top * 100}%`,
                  width: `${(selection.right - selection.left) * 100}%`,
                  height: `${(selection.bottom - selection.top) * 100}%`,
                }}
                aria-hidden="true"
              />
            )}
            {marker && highlights.length === 0 && !selection && (
              <div
                className={`marker ${status.kind === 'reading' ? 'pulse' : ''}`}
                style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
                aria-hidden="true"
              />
            )}
          </div>
        ) : (
          <div className="empty">
            <p>講義資料のPDFを開いてください。</p>
            <p>ここにファイルを落としても開けます。</p>
            <p>開いたら、読みたい場所をクリック（タップ）すると読み上げます。</p>
            <p>図やグラフを押すと、何の図かをひとことで説明します。もう一度押すと、くわしく説明します。</p>
            <p>説明してほしい所をドラッグで囲むと、その範囲だけを説明します。</p>
            <p>スペースキーで、上と下のメニューを隠して画面を広く使えます。</p>
          </div>
        )}
      </main>

      {!chromeHidden && (
        <footer className="reader" aria-live="polite">
          <div className="reader-status">
            {status.kind === 'reading' && <span className="badge">読み取り中…</span>}
            {status.kind === 'speaking' && <span className="badge speaking">読み上げ中</span>}
            {status.kind === 'error' && <span className="badge error">{status.message}</span>}
            {result && status.kind !== 'error' && status.kind !== 'reading' && (
              <span className="badge source">
                {result.source === 'pdf' ? 'PDFの文字' : result.source === 'figure' ? 'AIで図を説明' : 'AIで読み取り'}・{(result.ms / 1000).toFixed(1)}秒
                {voiceMs !== null && `／声まで ${(voiceMs / 1000).toFixed(1)}秒`}
              </span>
            )}
            {voiceNotice && <span className="badge error">{voiceNotice}</span>}
            {!speechSupported && <span className="badge error">このブラウザは読み上げに対応していません</span>}
          </div>
          <p className="reader-text">{text || '読み取った文字がここに大きく表示されます。'}</p>
          {engine === 'voicevox' && styles.length > 0 && (
            <p className="credit">
              音声：VOICEVOX:{styles.find((st) => st.id === speaker)?.speaker ?? ''}
            </p>
          )}
          <div className="reader-actions">
            {figure?.showing === 'summary' && (
              <button type="button" className="btn primary" onClick={onDetailButton}>
                くわしく
              </button>
            )}
            <button type="button" className="btn" onClick={() => say(text)} disabled={!text || busy}>
              もう一度
            </button>
            <button type="button" className="btn stop" onClick={stop} disabled={!busy}>
              ■ 止める
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}
