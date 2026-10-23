// @ts-check
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

// The browser signs NIP-98 for its own origin, so the proxy keeps the Host header: Vite's string shorthand
// would rewrite it to the target's.
const api = { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false }

export default defineConfig({
  integrations: [react()],
  // admin.html rather than admin/index.html: /admin is the page, /admin/* the API.
  build: { format: 'file' },
  vite: {
    plugins: [tailwindcss()],
    server: { proxy: { '/domains': api, '/addresses/': api, '/admin/': api } },
  },
})
