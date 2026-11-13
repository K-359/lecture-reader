import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
