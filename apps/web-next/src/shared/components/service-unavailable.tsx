export function ServiceUnavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-8">
      <div className="max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">服务暂时不可用</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          无法连接后端服务，可能是服务正在启动或维护中。请稍后刷新重试。
        </p>
      </div>
    </main>
  )
}
