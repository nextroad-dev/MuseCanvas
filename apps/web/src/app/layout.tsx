import type { Metadata, Viewport } from 'next'

import '@fontsource/google-sans/400.css'
import '@fontsource/google-sans/500.css'
import '@fontsource/google-sans/600.css'
import '@fontsource/google-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'

import './globals.css'

import { ThemeBootScript } from '@/shared/components/theme-boot-script'
import { AppProviders } from '@/shared/providers/app-providers'

export const metadata: Metadata = {
  title: {
    default: 'MuseCanvas',
    template: '%s · MuseCanvas',
  },
  description: '可以装在自己服务器上的 AI 画图与视频创作工作室：把构想写成一段文字，即刻生成画面并沉淀到个人图库。',
  applicationName: 'MuseCanvas',
  icons: { icon: '/favicon.png', apple: '/favicon.png' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <ThemeBootScript />
      </head>
      <body className="min-h-dvh bg-canvas font-sans text-foreground antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  )
}
