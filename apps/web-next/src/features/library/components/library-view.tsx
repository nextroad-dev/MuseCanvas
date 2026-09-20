'use client'

import { useEffect } from 'react'
import { useLibraryQuery, useDeleteAsset, useBatchDeleteAssets } from '@/shared/hooks/useLibrary'
import { MediaFrame } from '@/shared/components/media-frame'
import { useLibraryUiStore } from '@/shared/stores/library-ui-store'
import { assetPlaybackUrl, isVideoAsset } from '@/shared/types'
import {
  CheckSquare,
  Download,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Square,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react'

/** Segmented control values, mirroring `LibraryFilterKind`. */
const FILTER_KINDS = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图像' },
  { value: 'video', label: '视频' },
] as const

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

  const { data: assets = [], isLoading, refetch, isFetching } = useLibraryQuery()
  const deleteMutation = useDeleteAsset()
  const batchDeleteMutation = useBatchDeleteAssets()

  // GET /api/library ignores `kind` and returns a fixed page of 50 rows, so the
  // media-kind filter is client-side over the fetched list only.
  const visibleAssets =
    filterKind === 'all'
      ? assets
      : assets.filter((asset) => isVideoAsset(asset) === (filterKind === 'video'))

  // The preview target is looked up from the fetched list instead of holding a
  // snapshot, so a refetch (or delete) can never leave a stale object on screen.
  const previewAsset = assets.find((asset) => asset.id === previewAssetId) ?? null
  const previewIsVideo = previewAsset !== null && isVideoAsset(previewAsset)

  const isAllSelected =
    visibleAssets.length > 0 && visibleAssets.every((asset) => selectedAssetIds.includes(asset.id))
  const isAnySelected = selectedAssetIds.length > 0

  // Escape closes the lightbox. Focus may still sit on the tile button that
  // opened it, so the listener lives on the window, not the dialog subtree.
  useEffect(() => {
    if (!previewAssetId) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPreviewAssetId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewAssetId, setPreviewAssetId])

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
            {visibleAssets.map((asset) => {
              const selected = selectedAssetIds.includes(asset.id)
              return (
                <div
                  key={asset.id}
                  className={`group relative overflow-hidden rounded-[var(--radius-control)] border bg-surface transition-all ${
                    selected
                      ? 'border-accent ring-2 ring-accent'
                      : 'border-border hover:border-border-control'
                  }`}
                >
                  <MediaFrame
                    src={assetPlaybackUrl(asset)}
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
                    className="absolute right-2 top-2 z-10 cursor-pointer rounded-[var(--radius-control)] bg-surface/80 p-1 text-foreground shadow transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    {selected ? (
                      <CheckSquare className="h-4 w-4 text-accent" />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  {/* Hover Overlay info and actions */}
                  <div className="media-scrim absolute inset-0 flex flex-col justify-end p-3 opacity-0 transition-opacity group-hover:opacity-100">
                    <p className="line-clamp-2 text-xs text-foreground-inverse">{asset.prompt || '无提示词'}</p>
                    <div className="mt-2 flex items-center justify-between pt-1 border-t border-white/20">
                      <span className="font-mono text-[10px] text-white/70">
                        {new Date(asset.createdAt).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setPreviewAssetId(asset.id)}
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

        {/* Lightbox Modal */}
        {previewAsset && (
          <div
            onClick={(event) => {
              if (event.target === event.currentTarget) setPreviewAssetId(null)
            }}
            className="fixed inset-0 z-[var(--z-index-overlay)] flex items-center justify-center bg-overlay/80 p-4"
          >
            <button
              type="button"
              onClick={() => setPreviewAssetId(null)}
              aria-label="关闭预览"
              className="absolute right-4 top-4 rounded-full bg-overlay/40 p-2 text-foreground-inverse hover:bg-overlay/60"
            >
              <X className="h-6 w-6" />
            </button>
            <div className="max-h-[90vh] max-w-4xl overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-lg">
              <MediaFrame
                src={assetPlaybackUrl(previewAsset)}
                kind={previewIsVideo ? 'video' : 'image'}
                alt={previewAsset.prompt || ''}
                layout="stage"
                showControls={previewIsVideo}
                durationSeconds={previewAsset.durationSeconds}
                width={previewAsset.width}
                height={previewAsset.height}
                hasAudio={previewAsset.hasAudio}
                className={
                  previewIsVideo
                    ? 'max-h-[75vh] w-full object-contain'
                    : 'max-h-[75vh] w-auto object-contain'
                }
              />
              <div className="p-4">
                <p className="text-xs font-medium text-foreground">{previewAsset.prompt}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{new Date(previewAsset.createdAt).toLocaleString()}</span>
                  <a
                    href={assetPlaybackUrl(previewAsset)}
                    download
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-accent hover:underline"
                  >
                    <Download className="h-3.5 w-3.5" />
                    下载
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
