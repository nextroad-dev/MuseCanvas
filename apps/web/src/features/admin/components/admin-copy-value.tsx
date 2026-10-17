'use client'

import { useState } from 'react'
import { Alert, Button, Input, useToast } from '@/shared/components/ui'
import { copyAdminValue } from '../lib/admin-copy'

export function AdminCopyValue({ value, label, unavailable = '明文不可用，无法复制。' }: { value?: string; label: string; unavailable?: string }) {
  const [failed, setFailed] = useState(false)
  const [copying, setCopying] = useState(false)
  const toast = useToast()
  if (!value) return <span className="text-xs text-muted-foreground">{unavailable}</span>
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="min-w-0 select-text break-all font-mono">{value}</span>
      <Button variant="secondary" size="sm" className="min-h-[var(--control-lg)] md:min-h-[var(--control-sm)]" loading={copying} aria-label={`复制${label}`} onClick={async () => {
        setCopying(true)
        try {
          await copyAdminValue(value, navigator.clipboard)
          setFailed(false)
          toast.push({ variant: 'success', title: `${label}已复制` })
        } catch {
          setFailed(true)
        } finally {
          setCopying(false)
        }
      }}>复制</Button>
    </div>
    {failed && <>
      <Alert tone="info" role="status">无法自动复制。请选中下方完整值手动复制，或重试复制按钮。</Alert>
      <Input readOnly value={value} aria-label={`${label}完整值，供手动复制`} onFocus={(event) => event.target.select()} />
    </>}
  </div>
}
