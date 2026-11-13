import { cp, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * pdf.js が実行中に読みに行くファイル（日本語の文字の対応表 CMap、標準フォント、画像の復号用 wasm、色の ICC）を
 * /pdfjs/ から配る。これがないと、フォントを埋め込んでいない日本語の PDF で文字が全部消える。
 * 開発中は node_modules から直接返し、ビルド時は出力先にコピーする。
 */
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

function pdfjsAssets(): Plugin {
  const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  let outDir = 'dist'
  return {
    name: 'pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        const [dir] = rel.split('/')
        const file = path.join(pdfjsRoot, rel)
        if (!PDFJS_ASSET_DIRS.includes(dir) || !file.startsWith(pdfjsRoot + path.sep)) return next()
        try {
          if (!(await stat(file)).isFile()) return next()
          if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
          res.end(await readFile(file))
        } catch {
          next()
        }
      })
    },
    async closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        await cp(path.join(pdfjsRoot, dir), path.join(outDir, 'pdfjs', dir), { recursive: true })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  server: {
    port: 5175,
    strictPort: true,
    // タブレットから同じ Wi-Fi で開けるように
    host: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
