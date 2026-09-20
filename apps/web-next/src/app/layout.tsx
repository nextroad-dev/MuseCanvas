import type { Metadata } from 'next'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import './globals.css'
import { QueryProvider } from '@/shared/providers/query-provider'

export const metadata: Metadata = {
  title: 'MuseCanvas',
  description: 'MuseCanvas creative workspace',
  icons: { icon: '/favicon.png' },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" className="font-sans">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  )
}
