import Link from 'next/link'

import { BrandMark } from '@/shared/components/brand-mark'
import { Button } from '@/shared/components/ui/button'
import { APP_ROUTES } from '@/shared/lib/app-routes'

/** 404：无 JS 也要能读懂并离开，所以全部是服务端渲染的静态链接。 */
export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-canvas px-6 py-16">
      <BrandMark size={44} />
      <div className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col items-center gap-3 text-center">
        <p className="font-mono text-overline text-muted-foreground">404</p>
        <h1 className="text-title text-foreground">没有找到这个页面</h1>
        <p className="text-sm text-muted-foreground">
          链接可能已经失效，或者页面被移动过。回到首页，或直接进入创作台继续。
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link href={APP_ROUTES.home}>回到首页</Link>
        </Button>
        <Button variant="secondary" asChild>
          <Link href={APP_ROUTES.generate}>进入创作台</Link>
        </Button>
      </div>
    </main>
  )
}
