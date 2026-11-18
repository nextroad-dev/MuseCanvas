export default function StudioLoading() {
  return (
    <div
      role="status"
      aria-label="正在加载工作区"
      className="flex min-h-0 min-w-0 flex-1 bg-canvas"
    >
      <aside className="hidden w-64 shrink-0 border-r border-border/70 bg-surface/60 md:block lg:w-72" />
      <div className="flex-1 bg-canvas" />
      <span className="sr-only">正在加载工作区</span>
    </div>
  )
}
