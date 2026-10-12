'use client'

import { useEffect } from 'react'
import type { CSSProperties } from 'react'
// The root layout is replaced by this boundary, so its stylesheet is not in the
// tree: import the token sheet here so the `var(--…)` references resolve. The
// fallbacks below only apply if that sheet fails to load.
import './globals.css'

const pageStyle: CSSProperties = {
  margin: 0,
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
  boxSizing: 'border-box',
  background: 'var(--color-canvas, Canvas)',
  color: 'var(--color-foreground, CanvasText)',
  fontFamily: 'var(--font-sans, system-ui, sans-serif)',
}

const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: '28rem',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '32px 24px',
  borderRadius: 'var(--radius-card, 14px)',
  border: '1px solid var(--color-border, ButtonBorder)',
  background: 'var(--color-surface, Canvas)',
  boxShadow: 'var(--shadow-soft, none)',
}

const buttonBaseStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 'var(--control-md, 40px)',
  padding: '0 16px',
  border: 'none',
  borderRadius: 'var(--radius-control, 10px)',
  fontWeight: 500,
  textDecoration: 'none',
  cursor: 'pointer',
}

const primaryButtonStyle: CSSProperties = {
  ...buttonBaseStyle,
  background: 'var(--color-primary, ButtonText)',
  color: 'var(--color-on-primary, ButtonFace)',
}

const secondaryButtonStyle: CSSProperties = {
  ...buttonBaseStyle,
  background: 'var(--color-tonal, ButtonFace)',
  color: 'var(--color-foreground, ButtonText)',
}

/**
 * Last-resort boundary for failures in the root layout. It replaces `<html>` and
 * `<body>`, so it renders its own minimal document and uses no app components.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="zh-CN">
      <body style={pageStyle}>
        <main style={cardStyle}>
          <h1
            style={{
              margin: 0,
              fontSize: 'var(--text-module, 18px)',
              fontWeight: 'var(--text-module--font-weight, 500)',
              lineHeight: 'var(--text-module--line-height, 1.4)',
            }}
          >
            应用出现异常
          </h1>
          <p
            style={{
              margin: 0,
              color: 'var(--color-muted-foreground, GrayText)',
              lineHeight: 'var(--text-sm--line-height, 1.5)',
            }}
          >
            页面无法正常加载。可以先重试一次；如果仍然失败，请稍后再访问。
          </p>
          {error.digest ? (
            <p style={{ margin: 0, color: 'var(--color-muted-foreground, GrayText)' }}>错误编号：{error.digest}</p>
          ) : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
            <button type="button" onClick={() => reset()} style={primaryButtonStyle}>
              重试
            </button>
            <a href="/" style={secondaryButtonStyle}>
              返回首页
            </a>
          </div>
        </main>
      </body>
    </html>
  )
}
