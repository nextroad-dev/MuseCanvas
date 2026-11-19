import type { Metadata } from 'next'
import { LibraryView } from '@/features/library/components/library-view'
import { assetIdFromSearch } from '@/shared/lib/app-routes'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'

export const metadata: Metadata = {
  title: '作品图库',
  description: '浏览、查找与管理你的创作作品。',
}

type LibrarySearchParams = Promise<Record<string, string | string[] | undefined>>

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function LibraryPage({ searchParams }: { searchParams: LibrarySearchParams }) {
  const params = await searchParams
  const rawAsset = firstValue(params.asset)
  const initialAssetId = rawAsset ? assetIdFromSearch(`?asset=${encodeURIComponent(rawAsset)}`) : null

  return <LibraryView mode={WORKSPACE_MODE} initialAssetId={initialAssetId} />
}
