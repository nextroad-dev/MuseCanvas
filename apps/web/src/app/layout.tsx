import type { Metadata } from 'next'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import './globals.css'
import { QueryProvider } from '@/shared/providers/query-provider'
import { ToastProvider } from '@/shared/components/ui/toast'

export const metadata: Metadata = {
  title: 'MuseCanvas',
  description: '面向创作者的 AI 图像生成工作台：提示词、画幅与参考图、任务队列和作品图库保持在同一条创作路径上。',
  icons: { icon: '/favicon.png' },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" className="font-sans" suppressHydrationWarning>
      <head>
        {/* Theme bootstrap: manual choice (localStorage) beats the OS
            preference. Runs before first paint to avoid a light/dark flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('muse-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()`,
          }}
        />
      </head>
      {/* The canvas + foreground pair lives on `body`, not on each page: an
          overscroll or a route without its own wrapper would otherwise flash the
          browser default (white) under the dark theme. */}
      <body className="bg-canvas text-foreground antialiased">
        <ToastProvider>
          <QueryProvider>{children}</QueryProvider>
        </ToastProvider>
      </body>
    </html>
  )
}
