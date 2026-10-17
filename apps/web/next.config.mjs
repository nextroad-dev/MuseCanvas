import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001'

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react', '@phosphor-icons/react/ssr'],
  },
  output: process.env.STANDALONE === 'true' ? 'standalone' : undefined,
  outputFileTracingRoot: path.resolve(__dirname, '../../'),
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, 'src'),
      '@musecanvas/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
    }
    return config
  },
  async headers() {
    // 保守的 CSP：仅以 Report-Only 形式下发，避免打断 Next 的运行时。
    const csp = [
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
          { key: 'Content-Security-Policy-Report-Only', value: csp },
        ],
      },
    ]
  },
  async redirects() {

    return [
      {
        source: '/history',
        destination: '/library',
        permanent: false,
      },
      {
        source: '/admin/registration',
        destination: '/admin/users',
        permanent: false,
      },
      {
        source: '/admin/models',
        destination: '/admin/language-models',
        permanent: false,
      },
      {
        source: '/admin/plugins',
        destination: '/admin/media-models',
        permanent: false,
      },
      {
        source: '/admin/providers',
        destination: '/admin/media-models',
        permanent: false,
      },
    ]
  },
  async rewrites() {
    // 生产环境 /api 由 nginx location /api/ 直连后端：若走 Next 代理层，
    // X-Forwarded-Host 会被边缘 nginx 覆写，后端 mutationOriginValid 对所有写操作返回 403。
    // 仅本地开发启用此同源代理（Next dev 代理会正确设置 x-forwarded-host）。
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
