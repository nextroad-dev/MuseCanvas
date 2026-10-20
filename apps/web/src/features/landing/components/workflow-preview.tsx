import { ShowcaseFrame } from '@/features/landing/components/showcase-frame'

/**
 * 260px preview for each workflow step, drawn from the mock: a prompt card with a
 * reference thumbnail, labelled parameter chips, and a result grid. Decorative,
 * so the whole block is `aria-hidden`; the step copy beside it carries the meaning.
 */
export function WorkflowPreview({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div
        aria-hidden="true"
        className="flex h-[260px] flex-col justify-center rounded-control border border-border bg-canvas p-6"
      >
        <div className="flex flex-col gap-3.5 rounded-popover bg-surface p-4 shadow-floating">
          <p className="text-sm leading-[1.65] text-foreground">
            清晨的江南水乡，薄雾笼罩水面，一艘乌篷船停在青石台阶旁，柔和逆光，胶片质感
          </p>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShowcaseFrame
                file="ratio-3x4.webp"
                label="3:4"
                decorative
                className="size-8 shrink-0 rounded-control"
              />
              <span className="text-xs text-muted-foreground">参考图 1/4</span>
            </div>
            <span className="inline-flex size-8 items-center justify-center rounded-control bg-primary text-on-primary">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5" />
                <path d="M6 11l6-6 6 6" />
              </svg>
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (index === 1) {
    return (
      <div
        aria-hidden="true"
        className="flex h-[260px] flex-col justify-center rounded-control border border-border bg-canvas p-6"
      >
        <div className="flex flex-col gap-4 rounded-popover bg-surface p-4 shadow-floating">
          <div className="flex flex-col gap-1.5">
            <span className="text-overline text-muted-foreground">模型</span>
            <div className="flex gap-1 rounded-control bg-tonal p-[3px] text-xs">
              <span className="flex-1 rounded-control bg-surface px-1.5 py-1 text-center shadow-soft">
                图像 · 默认模型
              </span>
              <span className="flex-1 px-1.5 py-1 text-center text-muted-foreground">视频</span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-overline text-muted-foreground">画幅</span>
            <div className="flex flex-wrap gap-1.5 font-mono text-xs">
              {['1:1', '16:9', '9:16', '4:3'].map((ratio) => (
                <span key={ratio} className="rounded-control bg-tonal px-2 py-1">
                  {ratio}
                </span>
              ))}
              <span className="rounded-control bg-primary px-2 py-1 text-on-primary">3:4</span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-overline text-muted-foreground">张数</span>
            <div className="flex gap-1.5 font-mono text-xs">
              <span className="rounded-control bg-primary px-2.5 py-1 text-on-primary">1</span>
              <span className="rounded-control bg-tonal px-2.5 py-1">2</span>
              <span className="rounded-control bg-tonal px-2.5 py-1">4</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      aria-hidden="true"
      className="grid h-[260px] grid-cols-3 grid-rows-2 gap-2 rounded-control border border-border bg-canvas p-6"
    >
      <ShowcaseFrame file="ratio-3x4.webp" label="3:4" decorative className="rounded-control" />
      <ShowcaseFrame file="ratio-16x9.webp" label="16:9" decorative className="rounded-control" />
      <ShowcaseFrame
        file="ratio-1x1.webp"
        label="1:1"
        decorative
        className="rounded-control outline-2 outline-offset-2 outline-foreground"
      />
      <ShowcaseFrame file="ratio-9x16.webp" label="9:16" decorative className="rounded-control" />
      <ShowcaseFrame file="ratio-4x3.webp" label="4:3" decorative className="rounded-control" />
      <span className="flex items-center justify-center rounded-control border border-dashed border-border-control font-mono text-caption text-muted-foreground">
        生成中
      </span>
    </div>
  )
}
