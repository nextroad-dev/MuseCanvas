import { LibraryView } from '@/features/library/components/library-view'
import { Suspense } from 'react'
import LibraryLoading from './loading'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '作品图库 - MuseCanvas',
  description: 'AI 创作画廊与历史作品管理',
}

export default function LibraryPage() {
  // URL-backed filters consume useSearchParams and need a Suspense boundary.
  return (
    <Suspense fallback={<LibraryLoading />}>
      <LibraryView />
    </Suspense>
  )
}
