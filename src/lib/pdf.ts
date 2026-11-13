import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy, PDFPageProxy }

/** pdf.js が実行中に読むファイルの置き場所（vite.config.ts の pdfjsAssets で配っている） */
const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`

export async function openPdf(file: File): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await file.arrayBuffer())
  return getDocument({
    data,
    // フォントを埋め込んでいない日本語の PDF は、文字の対応表（CMap）がないと文字が全部消える
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
  }).promise
}

/** ページの縦横比（高さ / 幅） */
export function pageAspect(page: PDFPageProxy): number {
  const v = page.getViewport({ scale: 1 })
  return v.height / v.width
}

/**
 * ページを、横幅が pixelWidth ピクセルになるように canvas へ描く。
 * 返り値の RenderTask を cancel() すれば描画を途中でやめられる。
 */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  pixelWidth: number,
): RenderTask {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: pixelWidth / base.width })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  return page.render({ canvas, viewport })
}

export function isCancelled(error: unknown): boolean {
  return error instanceof RenderingCancelledException
}
