'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ImagesIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SparkleIcon,
  SquaresFourIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { Alert, Button, Checkbox, Dialog, EmptyState, Input, PageHeader, Skeleton, useToast } from '@/shared/components/ui'
import { libraryItems, useLibrary, useDeleteAsset, useBatchDeleteAssets, useAssetDownloadUrl } from '@/shared/hooks/useLibrary'
import { queryKeys } from '@/shared/hooks/query-keys'
import { APP_ROUTES, assetIdFromSearch } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatBytes, formatDate, formatDateTime } from '@/shared/lib/format'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import { useLibraryUiStore } from '@/shared/stores/library-ui-store'
import type { AssetDto } from '@/shared/types'
import { downloadableUrl, generationSearch, reusablePrompt, visibleSelection } from '../lib/library-actions'
import { AssetMedia } from './asset-media'

export interface LibraryViewProps { mode: WorkspaceMode }

const gridClasses = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
  6: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6',
} as const

export function LibraryView({ mode }: LibraryViewProps) {
  const { filters, selectedIds, columns, setColumns, setTab, setQuery, toggleSelect, selectMany, clearSelection } = useLibraryUiStore()
  const library = useLibrary({ ...(filters.tab === 'all' ? {} : { kind: filters.tab }), q: filters.q.trim() })
  const items = libraryItems(library.data)
  const selected = visibleSelection(selectedIds, items)
  // 控制台媒体结果用 `?asset=<uuid>` 深链到单个作品；非法参数等同未提供。
  const initialAssetId = assetIdFromSearch(useSearchParams().toString())
  const keepInitialAssetRef = useRef(true)
  const [activeId, setActiveId] = useState<string | null>(initialAssetId)
  const [pendingDelete, setPendingDelete] = useState<string[]>([])
  const [actionError, setActionError] = useState('')
  const remove = useDeleteAsset()
  const batchRemove = useBatchDeleteAssets()
  const download = useAssetDownloadUrl()
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const active = items.find((asset) => asset.id === activeId)
  const busy = remove.isPending || batchRemove.isPending
  const filtered = Boolean(filters.q.trim() || filters.tab !== 'all')
  const total = library.data?.pages[0]?.total ?? 0

  // 深链只在首次渲染保留；之后筛选变化仍按原行为关闭详情。
  useEffect(() => {
    clearSelection()
    setActiveId((current) => (keepInitialAssetRef.current && current === initialAssetId ? current : null))
    keepInitialAssetRef.current = false
  }, [filters.q, filters.tab, clearSelection, initialAssetId])

  function resetFilters() { setQuery(''); setTab('all') }

  async function handleDelete() {
    if (busy || !pendingDelete.length) return
    setActionError('')
    try {
      if (pendingDelete.length === 1) await remove.mutateAsync(pendingDelete[0])
      else await batchRemove.mutateAsync(pendingDelete)
      if (activeId && pendingDelete.includes(activeId)) setActiveId(null)
      setPendingDelete([])
      clearSelection()
      toast.success('作品已删除')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '未能完成删除，请刷新列表后重试。')
      // A batch may partially succeed. Do not leave successfully deleted assets in cache.
      setPendingDelete([])
      clearSelection()
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.library.root }),
        queryClient.invalidateQueries({ queryKey: queryKeys.jobs.root }),
      ])
    }
  }

  async function handleDownload(asset: AssetDto) {
    if (downloadingId) return
    setDownloadingId(asset.id)
    setActionError('')
    try {
      const signed = await download.mutateAsync(asset.id)
      const response = await fetch(downloadableUrl(signed.downloadUrl || signed.url, window.location.origin))
      if (!response.ok) throw new Error('下载失败，请稍后重试。')
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/svg+xml': 'svg' }
      anchor.download = `musecanvas-${asset.id.replace(/[^a-zA-Z0-9_-]/g, '')}.${extensions[signed.mimeType] || 'bin'}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
      toast.success('已开始下载')
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败，请稍后重试。'
      setActionError(message)
      toast.error('无法下载作品', message)
    } finally { setDownloadingId(null) }
  }

  return (
    <div className="min-w-0 space-y-6" data-workspace-mode={mode}>
      <PageHeader
        title="作品库"
        description="每一次灵感，都值得好好收藏。"
        meta={<span className="mb-2 font-mono text-caption tracking-widest text-accent">YOUR CREATIVE ARCHIVE</span>}
        actions={
          <Button asChild className="rounded-pill" icon={<PlusIcon aria-hidden="true" />}>
            <Link href={APP_ROUTES.generate}>开始创作</Link>
          </Button>
        }
      />

      {/* Sticky studio filter, search, and density toolbar */}
      <section
        aria-label="筛选作品"
        className="sticky top-[var(--layout-header)] z-sticky flex flex-col gap-3 rounded-panel border border-border bg-surface/95 p-3.5 shadow-soft backdrop-blur-sm md:flex-row md:items-center md:justify-between"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1 rounded-pill bg-tonal p-1" role="group" aria-label="作品类型">
            {([['all', '全部作品'], ['image', '图片'], ['video', '视频']] as const).map(([tab, label]) => (
              <Button
                key={tab}
                size="sm"
                className="rounded-pill"
                variant={filters.tab === tab ? 'primary' : 'ghost'}
                aria-pressed={filters.tab === tab}
                onClick={() => setTab(tab)}
              >
                {label}
              </Button>
            ))}
          </div>
          <p role="status" className="text-caption text-muted-foreground">
            {library.isPending
              ? '正在整理作品…'
              : `${filtered ? '找到' : '共'} ${total} 件作品`}
            {library.isFetching && !library.isPending ? ' · 更新中' : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <MagnifyingGlassIcon
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="搜索作品提示词"
              placeholder="搜索提示词，找回灵感…"
              value={filters.q}
              onChange={(event) => setQuery(event.target.value)}
              className="rounded-pill pl-9"
            />
          </div>
          <label className="inline-flex min-h-10 items-center gap-1.5 rounded-pill border border-border bg-canvas/60 px-3 text-ui text-muted-foreground">
            <SquaresFourIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">布局</span>
            <select
              aria-label="图库网格列数"
              value={columns}
              onChange={(event) => setColumns(Number(event.target.value) as 2 | 3 | 4 | 6)}
              className="bg-transparent py-1 text-ui font-medium text-foreground outline-none"
            >
              <option value={2}>宽松</option>
              <option value={3}>舒适</option>
              <option value={4}>紧凑</option>
              <option value={6}>密集</option>
            </select>
          </label>
        </div>
      </section>

      {actionError && (
        <Alert tone="danger" title="操作未完成" onDismiss={() => setActionError('')}>
          {actionError}
        </Alert>
      )}
      {mode === 'mock' && filters.tab === 'video' && (
        <Alert title="本地演示暂不提供视频样片">
          视频筛选可用，但本地演示不生成或模拟可播放的视频。切换到图片查看本地样片。
        </Alert>
      )}
      {library.isError && (
        <Alert
          tone="danger"
          title="作品加载失败"
          action={
            <Button size="sm" variant="secondary" onClick={() => void library.refetch()}>
              重新加载
            </Button>
          }
        >
          {library.error instanceof Error ? library.error.message : '请检查网络连接后重试。'}
        </Alert>
      )}

      {items.length > 0 && (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 rounded-card border px-4 py-2.5 transition-colors',
            selected.length > 0
              ? 'border-accent/30 bg-accent-soft/50'
              : 'border-border bg-surface',
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox
              checked={selected.length === items.length}
              indeterminate={selected.length > 0 && selected.length < items.length}
              label="选择当前已加载作品"
              onCheckedChange={(checked) =>
                checked ? selectMany(items.map((asset) => asset.id)) : clearSelection()
              }
              disabled={busy}
            />
            {selected.length > 0 && (
              <span role="status" className="rounded-pill bg-surface px-2.5 py-0.5 text-caption font-medium text-accent">
                已选 {selected.length} 件
              </span>
            )}
          </div>
          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="danger-ghost"
                className="rounded-pill"
                disabled={busy}
                onClick={() => {
                  setActionError('')
                  setPendingDelete(selected)
                }}
                icon={<TrashIcon aria-hidden="true" />}
              >
                删除所选
              </Button>
              <Button size="sm" variant="ghost" className="rounded-pill" onClick={clearSelection}>
                取消选择
              </Button>
            </div>
          )}
        </div>
      )}

      {library.isPending ? (
        <div aria-label="正在加载作品" aria-busy="true" className={cn('grid gap-4', gridClasses[columns])}>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="space-y-3 rounded-card border border-border bg-surface p-3">
              <Skeleton className="aspect-[4/5] h-auto w-full rounded-control" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : !items.length && !library.isError ? (
        <EmptyState
          icon={ImagesIcon}
          title={filtered ? '没有找到匹配的作品' : '你的灵感，即将在这里相遇'}
          description={
            filtered
              ? '试试其他关键词，或清除筛选查看全部作品。'
              : '前往创作台完成第一次生成，作品会自动收录到这里。'
          }
          action={
            filtered ? (
              <Button variant="secondary" className="rounded-pill" onClick={resetFilters}>
                清除筛选
              </Button>
            ) : (
              <Button asChild className="rounded-pill">
                <Link href={APP_ROUTES.generate}>创作第一件作品</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className={cn('grid gap-4', gridClasses[columns])}>
          {items.map((asset) => {
            const isSelected = selected.includes(asset.id)
            return (
              <article
                key={asset.id}
                className={cn(
                  'group min-w-0 overflow-hidden rounded-card border border-border bg-surface shadow-soft transition-all hover:shadow-floating',
                  isSelected && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas',
                )}
              >
                <div className="relative aspect-[4/5] overflow-hidden bg-tonal">
                  <button
                    type="button"
                    onClick={() => setActiveId(asset.id)}
                    aria-label={`查看作品：${asset.prompt || '未命名作品'}`}
                    className="block h-full w-full overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
                  >
                    <AssetMedia key={`${asset.id}-${asset.url}`} asset={asset} />
                  </button>

                  {/* Top-left selection checkbox */}
                  <div className="absolute left-2.5 top-2.5 rounded-control bg-surface/95 shadow-soft backdrop-blur-sm">
                    <Checkbox
                      aria-label={`选择作品：${asset.prompt || asset.id}`}
                      checked={isSelected}
                      onCheckedChange={() => toggleSelect(asset.id)}
                      disabled={busy}
                    />
                  </div>

                  {/* Bottom-left media kind pill */}
                  <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-pill bg-surface/90 px-2.5 py-0.5 font-mono text-caption text-foreground backdrop-blur-sm">
                    {asset.mediaKind === 'video' ? 'VIDEO' : 'IMAGE'}
                  </span>

                  {/* Hover scrim quick actions */}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-gradient-to-t from-overlay/60 via-overlay/20 to-transparent p-2.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <div className="pointer-events-auto flex items-center gap-1 rounded-pill border border-border bg-surface/95 p-1 shadow-floating backdrop-blur-sm">
                      <Link
                        href={`${APP_ROUTES.generate}?${generationSearch(asset)}`}
                        aria-label="在创作台复用提示词"
                        className="inline-flex size-8 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover"
                      >
                        <SparkleIcon className="size-4" aria-hidden="true" />
                      </Link>
                      <button
                        type="button"
                        aria-label="下载作品"
                        disabled={Boolean(downloadingId)}
                        onClick={() => void handleDownload(asset)}
                        className="inline-flex size-8 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover disabled:opacity-50"
                      >
                        <ArrowDownIcon className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label="删除作品"
                        disabled={busy}
                        onClick={() => {
                          setActionError('')
                          setPendingDelete([asset.id])
                        }}
                        className="inline-flex size-8 items-center justify-center rounded-pill text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
                      >
                        <TrashIcon className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex min-w-0 items-start justify-between gap-2 p-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setActiveId(asset.id)}
                  >
                    <p className="line-clamp-2 break-words text-sm text-foreground">
                      {reusablePrompt(asset) || '未命名作品'}
                    </p>
                    <p className="mt-1 font-mono text-caption text-muted-foreground">
                      {formatDate(asset.createdAt)}
                    </p>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 rounded-pill sm:hidden"
                    aria-label="下载作品"
                    disabled={Boolean(downloadingId)}
                    loading={downloadingId === asset.id}
                    onClick={() => void handleDownload(asset)}
                    icon={<ArrowDownIcon aria-hidden="true" />}
                  />
                </div>
              </article>
            )
          })}
        </div>
      )}

      {library.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            className="rounded-pill"
            loading={library.isFetchingNextPage}
            onClick={() => void library.fetchNextPage()}
          >
            加载更多作品
          </Button>
        </div>
      )}

      <Dialog
        open={Boolean(active)}
        onClose={() => setActiveId(null)}
        title="作品详情"
        description="查看原始作品、提示词与文件信息。"
        size="wide"
        footer={
          active ? (
            <>
              <Button
                variant="danger-ghost"
                onClick={() => {
                  setActionError('')
                  setPendingDelete([active.id])
                }}
                icon={<TrashIcon aria-hidden="true" />}
              >
                删除
              </Button>
              <Button
                variant="secondary"
                loading={downloadingId === active.id}
                disabled={Boolean(downloadingId)}
                onClick={() => void handleDownload(active)}
                icon={<ArrowDownIcon aria-hidden="true" />}
              >
                下载原文件
              </Button>
              <Button asChild icon={<ArrowRightIcon aria-hidden="true" />}>
                <Link href={`${APP_ROUTES.generate}?${generationSearch(active)}`}>复用提示词</Link>
              </Button>
            </>
          ) : undefined
        }
      >
        {active && (
          <div className="min-w-0 space-y-5">
            <AssetMedia key={active.id} asset={active} detail />
            <section className="space-y-2 rounded-card border border-border bg-tonal/40 p-4">
              <h3 className="text-sm font-medium text-foreground">提示词</h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                {reusablePrompt(active) || '未提供提示词'}
              </p>
            </section>
            <dl className="grid grid-cols-2 gap-4 rounded-card border border-border bg-surface p-4 text-sm sm:grid-cols-4">
              <Metadata label="创建时间" value={formatDateTime(active.createdAt)} />
              <Metadata label="文件类型" value={active.mimeType} />
              <Metadata
                label="分辨率"
                value={active.width && active.height ? `${active.width} × ${active.height}` : '—'}
              />
              <Metadata label="文件大小" value={formatBytes(active.sizeBytes)} />
              {active.mediaKind === 'video' && (
                <Metadata
                  label="时长"
                  value={active.durationSeconds === undefined ? '—' : `${active.durationSeconds} 秒`}
                />
              )}
            </dl>
          </div>
        )}
      </Dialog>

      <Dialog
        open={pendingDelete.length > 0}
        onClose={() => {
          if (!busy) setPendingDelete([])
        }}
        title={`删除 ${pendingDelete.length} 件作品？`}
        description="删除后无法恢复。关联的生成任务也可能被一并删除。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setPendingDelete([])}>
              保留作品
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void handleDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">请确认这些作品已不再需要，或先下载保存。</p>
      </Dialog>
    </div>
  )
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-mono text-xs text-foreground">{value}</dd></div>
}
