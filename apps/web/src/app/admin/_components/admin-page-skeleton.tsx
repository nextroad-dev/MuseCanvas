import { Card, PageHeader, SkeletonRow, SkeletonText, SkeletonTile } from '@/shared/components/ui'
import { adminPageHeader, adminPageRoot } from '@/features/admin/lib/admin-layout'

interface AdminPageSkeletonProps {
  title: string
  description: string
  variant?: 'list' | 'dashboard' | 'templates' | 'oauth' | 'settings' | 'resources'
}

/** Route fallbacks use the same main track and panel breakpoints as the client views. */
export function AdminPageSkeleton({ title, description, variant = 'list' }: AdminPageSkeletonProps) {
  const cardGrid = variant === 'templates'
    ? 'grid grid-cols-1 gap-4 @min-[640px]/admin:grid-cols-2 @min-[1040px]/admin:grid-cols-3'
    : 'grid gap-4 @min-[900px]/admin:grid-cols-2'
  return (
    <div className={adminPageRoot} role="status" aria-busy="true">
      <span className="sr-only">正在加载{title}</span>
      <PageHeader className={adminPageHeader} title={title} description={description} actions={<SkeletonTile className="aspect-auto h-10 w-24 rounded-control" />} />
      {variant === 'dashboard' && <section aria-hidden="true" className="flex flex-col gap-4">
        <SkeletonText width="12rem" className="text-module" />
        <SkeletonText width="28rem" className="text-sm" />
        <div className="grid grid-cols-1 gap-4 @min-[480px]/admin:grid-cols-2 @min-[1040px]/admin:grid-cols-4">
          {[0, 1, 2, 3].map((index) => <Card key={index}><SkeletonText width="7rem" /><SkeletonTile className="aspect-auto h-10 w-28 rounded-control" /><SkeletonText width="9rem" /></Card>)}
        </div>
      </section>}
      {(variant === 'settings' || title === '用户与邀请管理') && <div aria-hidden="true" className="flex max-w-full gap-2 overflow-hidden">
        {Array.from({ length: variant === 'settings' ? 4 : 2 }, (_, index) => <SkeletonTile key={index} className="aspect-auto h-10 w-28 shrink-0 rounded-control" />)}
      </div>}
      {variant !== 'settings' && <Card aria-hidden="true" density="compact" className="gap-4">
        <SkeletonText width="10rem" className="text-module" /><SkeletonText width="30rem" className="text-sm" />
        {(variant === 'list' || variant === 'templates') && <div className="grid gap-4 @min-[560px]/admin:grid-cols-2">
          {[0, 1].map((index) => <SkeletonTile key={index} className="aspect-auto h-10 w-full rounded-control" />)}
        </div>}
      </Card>}
      {variant === 'settings' ? <div className="w-full max-w-form" aria-hidden="true">
        <Card className="gap-6"><SkeletonText width="12rem" /><SkeletonText lines={2} />
          {[0, 1].map((index) => <div key={index} className="flex flex-col gap-2"><SkeletonText width="8rem" /><SkeletonTile className="aspect-auto h-10 w-full rounded-control" /></div>)}
        </Card>
        <Card className="mt-6 flex-row flex-wrap items-center justify-between gap-3"><SkeletonText width="10rem" /><SkeletonTile className="aspect-auto h-10 w-32 rounded-control" /></Card>
      </div> : variant === 'templates' || variant === 'oauth' ? <div className={cardGrid} aria-hidden="true">
        {Array.from({ length: variant === 'templates' ? 6 : 2 }, (_, index) => <Card key={index} density={variant === 'templates' ? 'compact' : 'comfortable'} className="gap-4">
          <SkeletonText width="12rem" className="text-module" /><SkeletonText lines={variant === 'templates' ? 3 : 2} /><SkeletonTile className="aspect-auto h-10 w-full rounded-control" />
        </Card>)}
      </div> : <div aria-hidden="true">
        <div className="flex flex-col gap-3 @min-[800px]/admin:hidden">
          {[0, 1, 2].map((index) => <Card key={index} density="compact"><SkeletonText width="12rem" className="text-module" /><SkeletonText width="16rem" /><SkeletonTile className="aspect-auto h-12 w-full rounded-control" /></Card>)}
        </div>
        <Card className="hidden gap-3 @min-[800px]/admin:flex">
          <SkeletonRow cells={variant === 'resources' ? 5 : 4} />
          {[0, 1, 2, 3, 4].map((index) => <SkeletonRow key={index} cells={variant === 'resources' ? 5 : 4} />)}
        </Card>
      </div>}
    </div>
  )
}
