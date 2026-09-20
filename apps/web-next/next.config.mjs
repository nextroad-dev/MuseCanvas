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
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
