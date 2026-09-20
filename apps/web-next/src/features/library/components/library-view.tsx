'use client'

import { useCallback, useMemo } from 'react'
import type { CSSProperties } from 'react'
import {
  libraryPageItems,
  useBatchDeleteAssets,
  useDeleteAsset,
  useLibraryInfiniteQuery,
} from '@/shared/hooks/useLibrary'
import { MediaFrame } from '@/shared/components/media-frame'
import { useLibraryUiStore } from '@/shared/stores/library-ui-store'
import { assetPlaybackUrl, assetPreviewUrl, isVideoAsset } from '@/shared/types'
import { AssetLightbox } from './asset-lightbox'
import {
  CheckSquare,
  Download,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Square,
  Trash2,
  ZoomIn,
} from 'lucide-react'

/** Segmented control values, mirroring `LibraryFilterKind`. */
const FILTER_KINDS = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图像' },
  { value: 'video', label: '视频' },
] as const

/** Cells past this index share one delay: `.motion-stagger` clamps at 12 steps,
 *  so the tail of a 50-row page must not advertise a wait it will never pay. */
const STAGGER_CLAMP = 12

export function LibraryView() {
  // Per-field selectors: a bare store destructure re-renders on any field change.
  const selectedAssetIds = useLibraryUiStore((s) => s.selectedAssetIds)
  const toggleSelectAsset = useLibraryUiStore((s) => s.toggleSelectAsset)
  const selectAllAssets = useLibraryUiStore((s) => s.selectAllAssets)
  const clearSelectedAssets = useLibraryUiStore((s) => s.clearSelectedAssets)
  const columnCount = useLibraryUiStore((s) => s.columnCount)
  const setColumnCount = useLibraryUiStore((s) => s.setColumnCount)
  const filterKind = useLibraryUiStore((s) => s.filterKind)
  const setFilterKind = useLibraryUiStore((s) => s.setFilterKind)
  const previewAssetId = useLibraryUiStore((s) => s.previewAssetId)
  const setPreviewAssetId = useLibraryUiStore((s) => s.setPreviewAssetId)

  // One keyset page at a time (see GET /api/library). `total` comes from the first
  // page because it counts the whole predicate, not the window.
  const { data, isLoading, refetch, isFetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useLibraryInfiniteQuery({ limit: 30 })
  const assets = useMemo(() => libraryPageItems(data), [data])
  const total = data?.pages[0]?.total ?? assets.length
  const deleteMutation = useDeleteAsset()
  const batchDeleteMutation = useBatchDeleteAssets()

  // `kind` is a server-side predicate now, but the page keeps filtering the
  // accumulated tiles locally so switching a filter never refetches what is already on
  // screen. `hasNextPage` stays the way to reach what the filter has hidden.
  const visibleAssets =
    filterKind === 'all'
      ? assets
      : assets.filter((asset) => isVideoAsset(asset) === (filterKind === 'video'))

  // Escape / arrows / focus restore all live in `useDialog` behind the lightbox.
  // These two callbacks are stable so the dialog never re-binds its window keydown.
  const closePreview = useCallback(() => setPreviewAssetId(null), [setPreviewAssetId])
  const openPreview = useCallback((assetId: string) => setPreviewAssetId(assetId), [setPreviewAssetId])

  const isAllSelected =
    visibleAssets.length > 0 && visibleAssets.every((asset) => selectedAssetIds.includes(asset.id))
  const isAnySelected = selectedAssetIds.length > 0

  async function handleBatchDelete() {
    if (!isAnySelected) return
    if (confirm(`确认删除选中的 ${selectedAssetIds.length} 个作品？此操作不可恢复。`)) {
      await batchDeleteMutation.mutateAsync(selectedAssetIds)
      clearSelectedAssets()
    }
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6">
        {/* Top bar controls */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">作品图库</h1>
            <p className="text-sm text-muted-foreground">浏览、下载与管理您所生成的所有图片与视频作品。</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Batch actions */}
            {isAnySelected && (
              <button
                type="button"
                onClick={handleBatchDelete}
                disabled={batchDeleteMutation.isPending}
                className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-danger-soft px-3 text-xs font-medium text-danger hover:bg-danger-soft/80"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除选中 ({selectedAssetIds.length})
              </button>
            )}

            {visibleAssets.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  isAllSelected ? clearSelectedAssets() : selectAllAssets(visibleAssets.map((a) => a.id))
                }
                className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-subtle"
              >
                {isAllSelected ? (
                  <CheckSquare className="h-3.5 w-3.5 text-accent" />
                ) : (
                  <Square className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                {isAllSelected ? '取消全选' : '全选'}
              </button>
            )}

            {/* Media kind filter (client-side over the fetched page) */}
            <div className="flex rounded-[var(--radius-control)] border border-border bg-surface p-0.5">
              {FILTER_KINDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={filterKind === option.value}
                  onClick={() => setFilterKind(option.value)}
                  className={`rounded-[calc(var(--radius-control)-2px)] px-2 py-1 text-xs font-medium transition-colors ${
                    filterKind === option.value
                      ? 'bg-surface-subtle text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {/* Column count buttons */}
            <div className="hidden sm:flex rounded-[var(--radius-control)] border border-border bg-surface p-0.5">
              {([2, 3, 4, 6] as const).map((cols) => (
                <button
                  key={cols}
                  type="button"
                  onClick={() => setColumnCount(cols)}
                  className={`rounded-[calc(var(--radius-control)-2px)] px-2 py-1 text-xs font-medium transition-colors ${
                    columnCount === cols
                      ? 'bg-surface-subtle text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {cols}列
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-subtle"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>
        </div>

        {/* Gallery Grid */}
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
          </div>
        ) : visibleAssets.length > 0 ? (
          <div
            className={`grid gap-4 ${
              columnCount === 2
                ? 'grid-cols-2'
                : columnCount === 3
                  ? 'grid-cols-2 sm:grid-cols-3'
                  : columnCount === 6
                    ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'
                    : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'
            }`}
          >
            {visibleAssets.map((asset, index) => {
              const selected = selectedAssetIds.includes(asset.id)
              return (
                <div
                  key={asset.id}
                  style={{ '--stagger-index': String(Math.min(index, STAGGER_CLAMP)) } as CSSProperties}
                  className={`group motion-lift motion-reveal motion-stagger relative overflow-hidden rounded-[var(--radius-control)] border bg-surface ${
                    selected
                      ? 'border-accent ring-2 ring-accent'
                      : 'border-border hover:border-border-control'
                  }`}
                >
                  {/* `src` stays the original: it is what a failed preview retries
                      against and what the tile's download link serves. */}
                  <MediaFrame
                    src={assetPlaybackUrl(asset)}
                    previewSrc={assetPreviewUrl(asset)}
                    kind={isVideoAsset(asset) ? 'video' : 'image'}
                    alt={asset.prompt || 'Generated asset'}
                    layout="tile"
                    durationSeconds={asset.durationSeconds}
                    width={asset.width}
                    height={asset.height}
                    hasAudio={asset.hasAudio}
                    showControls={false}
                  />

                  {/* Top-right selection checkbox */}
                  <div
                    onClick={() => toggleSelectAsset(asset.id)}
                    className="motion-hover-fade absolute right-2 top-2 z-10 cursor-pointer rounded-[var(--radius-control)] bg-surface/80 p-1 text-foreground shadow sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    {selected ? (
                      <CheckSquare className="h-4 w-4 text-accent" />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  {/* Hover Overlay info and actions */}
                  <div className="media-scrim motion-hover-fade absolute inset-0 flex flex-col justify-end p-3 opacity-0 group-hover:opacity-100">
                    <p className="line-clamp-2 text-xs text-foreground-inverse">{asset.prompt || '无提示词'}</p>
                    <div className="mt-2 flex items-center justify-between pt-1 border-t border-white/20">
                      <span className="font-mono text-[10px] text-white/70">
                        {new Date(asset.createdAt).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openPreview(asset.id)}
                          className="rounded bg-overlay/40 p-1 text-foreground-inverse hover:bg-overlay/60"
                          title="放大查看"
                        >
                          <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                        <a
                          href={assetPlaybackUrl(asset)}
                          download
                          target="_blank"
                          rel="noreferrer"
                          className="rounded bg-overlay/40 p-1 text-foreground-inverse hover:bg-overlay/60"
                          title="下载"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm('确认删除该作品？')) {
                              deleteMutation.mutate(asset.id)
                            }
                          }}
                          className="rounded bg-danger-soft p-1 text-danger hover:bg-danger-soft/80"
                          title="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : assets.length > 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-[var(--radius-card)] border border-border bg-surface-subtle p-8 text-center">
            <h3 className="font-semibold text-foreground">当前筛选下没有作品</h3>
            <p className="text-xs text-muted-foreground">切换到「全部」即可查看所有图片与视频作品。</p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center rounded-[var(--radius-card)] border border-border bg-surface-subtle p-12 text-center">
            <ImageIcon className="h-12 w-12 text-muted-foreground/40" />
            <h3 className="mt-3 font-semibold text-foreground">作品库空空如也</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              在创作控制台完成图片或视频生成后，所有作品都将在此永久归档。
            </p>
          </div>
        )}

        {/* The load-more control lives outside the grid branch on purpose: with a kind
            filter active every loaded tile can be hidden while older work is still one
            request away, and a button inside the grid would vanish with it. */}
        {hasNextPage && (
          <div className="flex flex-wrap items-center justify-center gap-3 pb-2">
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle disabled:opacity-60"
            >
              {isFetchingNextPage ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              加载更多作品
            </button>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              已显示 {assets.length} / {total}
            </span>
          </div>
        )}

        {/* Full-size preview: portal, focus trap and the close animation are all
            in `AssetLightbox` / `useDialog`, so no window keydown lives here. */}
        <AssetLightbox
          assets={visibleAssets}
          activeAssetId={previewAssetId}
          onClose={closePreview}
          onSelect={openPreview}
        />
      </div>
    </div>
  )
}
