/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * og:image / og:url / canonical must be absolute URLs, so they are only
 * emitted when the deployment's public origin is known (VITE_SITE_URL).
 */
function siteMeta(siteUrl: string | undefined): Plugin {
  const origin = siteUrl?.trim().replace(/\/+$/, '')
  return {
    name: 'mopi-site-meta',
    transformIndexHtml() {
      if (!origin) return []
      const tags: HtmlTagDescriptor[] = [
        { tag: 'link', attrs: { rel: 'canonical', href: `${origin}/` }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:url', content: `${origin}/` }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:image', content: `${origin}/og.png` }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${origin}/og.png` }, injectTo: 'head' },
      ]
      return tags
    },
  }
}

const VENDOR_REACT = /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    plugins: [react(), siteMeta(env.VITE_SITE_URL)],
    define: {
      // web3.js and the wallet adapters expect a Node-like `global`.
      global: 'globalThis',
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      // The Solana vendor chunk (web3.js, curves, wallet adapters) is ~470 kB
      // on its own; anything above this deserves a look.
      chunkSizeWarningLimit: 520,
      rollupOptions: {
        output: {
          // Vendor code changes far less often than the app: separate chunks
          // stay cached across deploys.
          manualChunks(id) {
            if (VENDOR_REACT.test(id)) return 'react'
            // The Buffer polyfill must run before web3.js evaluates, so it
            // lives in the same chunk, ahead of it in execution order.
            if (id.includes('node_modules') || /[\\/]src[\\/]polyfills\.ts$/.test(id)) return 'vendor'
            return undefined
          },
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['src/test/setup.ts'],
    },
  }
})
