import Link from 'next/link'
import type { Metadata } from 'next'
import { ContentFrame } from '@/shared/components/content-frame'
import { EmptyState } from '@/shared/components/ui'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'

export const metadata: Metadata = {
  title: '页面不存在 - MuseCanvas',
  description: '你访问的页面不存在或已经移动。',
}

export default function NotFound() {
  return (
    <ContentFrame className="motion-page-enter flex min-h-[60vh] flex-col justify-center py-6 md:py-8">
      <EmptyState
        variant="no-results"
        title="页面不存在"
        description="你访问的地址可能已经移动或不存在。"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href={GENERATE_ROUTE} className={buttonVariants({ variant: 'primary' })}>
              前往创作台
            </Link>
            <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
              返回首页
            </Link>
          </div>
        }
      />
    </ContentFrame>
  )
}
