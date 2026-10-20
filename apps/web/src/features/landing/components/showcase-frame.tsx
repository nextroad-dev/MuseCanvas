import Image from 'next/image'
import { showcasePrompt, showcaseSrc } from '@/shared/lib/showcase'
import { cn } from '@/shared/lib/cn'

interface ShowcaseFrameProps {
  /** File name under `public/showcase/`; the only image source on the landing page. */
  file: string
  /** Ratio label, used only for the fallback alt text (e.g. `3:4`). */
  label: string
  /** Repeated thumbnails next to a labelled image pass this and get `alt=""`. */
  decorative?: boolean
  /** Shape and size only: the caller sets width, height or aspect ratio. */
  className?: string
  sizes?: string
}

/**
 * Showcase image in a box the caller sizes. A missing asset renders a `bg-tonal`
 * placeholder, so the page builds and renders without the binary files.
 */
export function ShowcaseFrame({
  file,
  label,
  decorative = false,
  className,
  sizes = '(max-width: 640px) 100vw, 50vw',
}: ShowcaseFrameProps) {
  const src = showcaseSrc(file)
  return (
    <div className={cn('relative overflow-hidden bg-tonal', className)}>
      {src ? (
        <Image
          src={src}
          alt={decorative ? '' : showcasePrompt(file, label)}
          fill
          sizes={sizes}
          className="object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-decorative-muted"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="2" />
            <path d="M21 16l-5-5-9 9" />
          </svg>
          <span className="font-mono text-xs tabular-nums">[作品图]</span>
        </span>
      )}
    </div>
  )
}
