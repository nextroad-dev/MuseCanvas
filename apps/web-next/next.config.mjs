import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001'

/** @type {import('next').NextConfig} */
const nextConfig = {
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
  async redirects() {

    return [
      {
        source: '/history',
        destination: '/generate?tab=history',
        permanent: true,
      },
      {
        source: '/admin/registration',
        destination: '/admin/users',
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
