'use client'

import { useState } from 'react'
import { useLibraryQuery, useDeleteAsset, useBatchDeleteAssets } from '@/shared/hooks/useLibrary'
import { useLibraryUiStore } from '@/shared/stores/library-ui-store'
import type { Asset } from '@/shared/types'
import {
  CheckSquare,
  Download,
  Grid3X3,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Square,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react'

export function LibraryView() {
  const {
    selectedAssetIds,
    toggleSelectAsset,
    selectAllAssets,
    clearSelectedAssets,
    columnCount,
    setColumnCount,
  } = useLibraryUiStore()

  const { data: assets = [], isLoading, refetch, isFetching } = useLibraryQuery()
  const deleteMutation = useDeleteAsset()
  const batchDeleteMutation = useBatchDeleteAssets()

  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null)

  const isAllSelected = assets.length > 0 && selectedAssetIds.length === assets.length
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
            <p className="text-sm text-muted-foreground">浏览、下载与管理您所生成的所有历史图片作品。</p>
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

            {assets.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  isAllSelected ? clearSelectedAssets() : selectAllAssets(assets.map((a) => a.id))
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
        ) : assets.length > 0 ? (
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
            {assets.map((asset) => {
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
                  <img
                    src={asset.url}
                    alt={asset.prompt || 'Generated asset'}
                    className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    loading="lazy"
                  />

                  {/* Top-right selection checkbox */}
                  <div
                    onClick={() => toggleSelectAsset(asset.id)}
                    className="absolute right-2 top-2 z-10 cursor-pointer rounded bg-surface/80 p-1 text-foreground shadow transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    {selected ? (
                      <CheckSquare className="h-4 w-4 text-accent" />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  {/* Hover Overlay info and actions */}
                  <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/80 via-black/20 to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100">
                    <p className="line-clamp-2 text-xs text-white">{asset.prompt || '无提示词'}</p>
                    <div className="mt-2 flex items-center justify-between pt-1 border-t border-white/20">
                      <span className="font-mono text-[10px] text-white/70">
                        {new Date(asset.createdAt).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setPreviewAsset(asset)}
                          className="rounded bg-white/20 p-1 text-white hover:bg-white/40"
                          title="放大查看"
                        >
                          <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                        <a
                          href={asset.url}
                          download
                          target="_blank"
                          rel="noreferrer"
                          className="rounded bg-white/20 p-1 text-white hover:bg-white/40"
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
                          className="rounded bg-white/20 p-1 text-red-300 hover:bg-red-500 hover:text-white"
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
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center rounded-[var(--radius-card)] border border-border bg-surface-subtle p-12 text-center">
            <ImageIcon className="h-12 w-12 text-muted-foreground/40" />
            <h3 className="mt-3 font-semibold text-foreground">作品库空空如也</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              在创作控制台完成生图后，所有生成的图片都将在此永久归档。
            </p>
          </div>
        )}

        {/* Lightbox Modal */}
        {previewAsset && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
            <button
              type="button"
              onClick={() => setPreviewAsset(null)}
              className="absolute right-4 top-4 rounded-full bg-white/20 p-2 text-white hover:bg-white/40"
            >
              <X className="h-6 w-6" />
            </button>
            <div className="max-h-[90vh] max-w-4xl overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-2xl">
              <img
                src={previewAsset.url}
                alt={previewAsset.prompt || ''}
                className="max-h-[75vh] w-auto object-contain"
              />
              <div className="p-4">
                <p className="text-xs font-medium text-foreground">{previewAsset.prompt}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{new Date(previewAsset.createdAt).toLocaleString()}</span>
                  <a
                    href={previewAsset.url}
                    download
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-accent hover:underline"
                  >
                    <Download className="h-3.5 w-3.5" />
                    下载原图
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
