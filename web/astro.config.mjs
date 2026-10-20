// @ts-check
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

const api = process.env.API_URL ?? 'http://localhost:3000'

export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // The browser signs NIP-98 for its own origin, and the proxy keeps the Host header.
    server: { proxy: { '/domains': api } },
  },
})
