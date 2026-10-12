import { Alert, Button } from '@/shared/components/ui'

/** Keep previous data visible when a background refresh fails. */
export function AdminQueryFeedback({
  error,
  hasData,
  label,
  onRetry,
}: {
  error: Error | null
  hasData: boolean
  label: string
  onRetry: () => void
}) {
  if (!error) return null
  return (
    <Alert
      tone="danger"
      role="alert"
      title={hasData ? `${label}刷新失败` : `无法加载${label}`}
      action={<Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>}
    >
      {error.message}。{hasData ? '仍显示上次成功的数据，可能已过时。' : '请稍后重试。'}
    </Alert>
  )
}
