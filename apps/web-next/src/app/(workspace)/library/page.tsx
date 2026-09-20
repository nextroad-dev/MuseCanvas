import { LibraryView } from '@/features/library/components/library-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '作品图库 - MuseCanvas',
  description: 'AI 创作画廊与历史作品管理',
}

export default function LibraryPage() {
  return <LibraryView />
}
