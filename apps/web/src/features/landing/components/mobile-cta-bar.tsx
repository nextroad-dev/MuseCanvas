import Link from 'next/link'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

/**
 * Fixed bottom "开始创作" bar for phones only (below `sm`). Safe-area aware, so
 * it clears the home indicator. The footer adds matching bottom padding below
 * `sm`, so the last links are never hidden under the bar.
 */
export function MobileCtaBar() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-sticky border-t border-border bg-canvas/[0.94] px-4 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))] backdrop-blur-sm sm:hidden">
      <Link href={GENERATE_ROUTE} className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full text-base')}>
        开始创作
      </Link>
    </div>
  )
}
