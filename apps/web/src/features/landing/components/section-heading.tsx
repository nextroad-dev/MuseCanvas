import { cn } from '@/shared/lib/cn'

/**
 * Landing section title (mock: 48px desktop, 36px mobile) with an optional 24px lede.
 * Sizes use arbitrary `length:` values on purpose: the shared title tokens are
 * 32px / 24px and do not reach the mock's display scale.
 */
export function SectionHeading({
  id,
  title,
  lede,
  className,
}: {
  id: string
  title: string
  lede?: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <h2
        id={id}
        className="text-[length:clamp(2.25rem,calc(0.9rem_+_2.4vw),3rem)] font-medium leading-[1.2] text-foreground [text-wrap:balance]"
      >
        {title}
      </h2>
      {lede ? (
        <p className="text-[length:1.5rem] font-medium leading-[1.4] text-foreground/85 [text-wrap:balance]">
          {lede}
        </p>
      ) : null}
    </div>
  )
}
