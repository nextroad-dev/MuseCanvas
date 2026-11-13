import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const monorepoRoot = path.resolve(here, '../..')
// 本地开发时 Next 以同源 /api 反向代理到后端；生产交给 nginx。
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001'

/**
 * 安全响应头。CSP 只以 Report-Only 形式下发：Next 的运行时脚本目前仍需
 * `'unsafe-inline'` / `'unsafe-eval'`，强制拦截会打断首屏与路由切换。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self'",
  "object-src 'none'",
].join('; ')

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react', '@phosphor-icons/react/ssr'],
  },
  output: process.env.STANDALONE === 'true' ? 'standalone' : undefined,
  // Docker 构建在仓库根执行；把追踪根指向 monorepo 根，standalone 才能带齐依赖。
  outputFileTracingRoot: monorepoRoot,
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(here, 'src'),
      '@musecanvas/contracts': path.resolve(here, '../../packages/contracts/src/index.ts'),
    }
    return config
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          { key: 'Content-Security-Policy-Report-Only', value: CONTENT_SECURITY_POLICY },
        ],
      },
    ]
  },
  async redirects() {
    // 旧信息架构的别名路径，全部临时重定向（307）到新路由。
    return [
      { source: '/history', destination: '/library', permanent: false },
      { source: '/admin/registration', destination: '/admin/users', permanent: false },
      { source: '/admin/models', destination: '/admin/language-models', permanent: false },
      { source: '/admin/plugins', destination: '/admin/media-models', permanent: false },
      { source: '/admin/providers', destination: '/admin/media-models', permanent: false },
    ]
  },
  async rewrites() {
    // 生产环境 /api 由 nginx 直连后端：若再经 Next 代理，X-Forwarded-Host 会被
    // 边缘 nginx 覆写，后端 mutationOriginValid 会对所有写操作返回 403。
    if (process.env.NODE_ENV === 'production') return []
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
