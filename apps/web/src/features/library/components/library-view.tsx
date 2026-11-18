'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ImageIcon,
  ImagesIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon,
  SparkleIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { SessionSidebar } from '@/features/agent-console/components/session-sidebar'
import { useAgentConsoleStore } from '@/features/agent-console/stores/agent-console-store'
import { Alert, Button, Checkbox, Dialog, EmptyState, Skeleton, iconSize, useToast } from '@/shared/components/ui'
import { queryKeys } from '@/shared/hooks/query-keys'
import { libraryItems, useAssetDownloadUrl, useBatchDeleteAssets, useDeleteAsset, useLibrary } from '@/shared/hooks/useLibrary'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatBytes, formatDate, formatDateTime } from '@/shared/lib/format'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import { useLibraryUiStore } from '@/shared/stores/library-ui-store'
import type { AssetDto } from '@/shared/types'
import {
  downloadableUrl,
  generationSearch,
  imageReuseSearch,
  previewSource,
  reusablePrompt,
  visibleSelection,
} from '../lib/library-actions'
import { AssetMedia } from './asset-media'

export interface LibraryViewProps { mode: WorkspaceMode }

const gridClasses = {
  2: 'grid-cols-1 sm:grid-cols-2 gap-5',
  3: 'grid-cols-2 sm:grid-cols-3 gap-4',
  4: 'grid-cols-2 sm:grid-cols-4 gap-3.5',
  6: 'grid-cols-2 sm:grid-cols-5 md:grid-cols-6 gap-2.5',
} as const

const TYPE_FILTERS = [
  ['all', '全部作品'],
  ['image', '图片'],
  ['video', '视频'],
] as const

const QUICK_FILTERS = [
  ['all', '全部'],
  ['image', '图片'],
  ['video', '视频'],
] as const

const DENSITY_OPTIONS = [
  [2, '宽松'],
  [3, '舒适'],
  [4, '紧凑'],
  [6, '密集'],
] as const

function isDesktopLeftInline(): boolean {
  if (typeof window === 'undefined') return true
  return window.matchMedia?.('(min-width: 960px)')?.matches ?? true
}

export function LibraryView({ mode }: LibraryViewProps) {
  const { filters, selectedIds, columns, setColumns, setTab, setQuery, toggleSelect, selectMany, clearSelection } = useLibraryUiStore()
  const leftSidebarOpen = useAgentConsoleStore((state) => state.leftSidebarOpen)
  const setLeftSidebarOpen = useAgentConsoleStore((state) => state.setLeftSidebarOpen)
  const toggleLeftSidebar = useAgentConsoleStore((state) => state.toggleLeftSidebar)

  const library = useLibrary({ ...(filters.tab === 'all' ? {} : { kind: filters.tab }), q: filters.q.trim() })
  const items = libraryItems(library.data)
  const selected = visibleSelection(selectedIds, items)
  const [activeId, setActiveId] = useState<string | null>(null)
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

  useEffect(() => { clearSelection(); setActiveId(null) }, [filters.q, filters.tab, clearSelection])

  // 窄视口首屏折叠为抽屉，避免打开页面时直接遮挡图库画布。
  const viewportInitializedRef = useRef(false)
  useEffect(() => {
    if (viewportInitializedRef.current || typeof window === 'undefined') return
    viewportInitializedRef.current = true
    if (!isDesktopLeftInline()) {
      setLeftSidebarOpen(false)
    }
  }, [setLeftSidebarOpen])

  useEffect(() => {
    if (!leftSidebarOpen || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !isDesktopLeftInline()) {
        setLeftSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [leftSidebarOpen, setLeftSidebarOpen])

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
    <div
      data-workspace-mode={mode}
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas"
    >
      {leftSidebarOpen ? (
        <div
          aria-hidden="true"
          onClick={() => setLeftSidebarOpen(false)}
          className="motion-fade-in absolute inset-0 z-sticky bg-overlay/35 backdrop-blur-xs md:hidden"
        />
      ) : null}

      <aside
        aria-label="作品图库侧栏"
        className={cn(
          'max-md:motion-drawer-in-left absolute inset-y-0 left-0 z-sticky w-72 max-w-[85vw] border-r border-border/70 bg-surface/95 backdrop-blur-md shadow-drawer',
          'md:static md:inset-y-auto md:z-auto md:h-full md:w-64 md:max-w-none md:shrink-0 md:bg-surface/60 md:backdrop-blur-none md:shadow-none lg:w-72',
          !leftSidebarOpen && 'hidden',
        )}
      >
        <SessionSidebar
          activeRoute="library"
          onToggleSidebar={toggleLeftSidebar}
          onCloseMobile={() => {
            if (!isDesktopLeftInline()) setLeftSidebarOpen(false)
          }}
        >
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between px-1 pb-1.5">
                <span className="text-caption font-medium text-muted-foreground">作品类型</span>
                <span role="status" className="text-caption tabular-nums text-muted-foreground">
                  {library.isPending ? '加载中…' : `${filtered ? '找到' : '共'} ${total} 件`}
                </span>
              </div>
              <div role="group" aria-label="作品类型" className="space-y-1">
                {TYPE_FILTERS.map(([tab, label]) => {
                  const activeTab = filters.tab === tab
                  return (
                    <button
                      key={tab}
                      type="button"
                      aria-pressed={activeTab}
                      onClick={() => setTab(tab)}
                      className={cn(
                        'motion-press flex w-full items-center justify-between rounded-control border px-3 py-2 text-left text-ui transition-colors',
                        activeTab
                          ? 'border-border/70 bg-surface font-medium text-foreground shadow-soft'
                          : 'border-transparent text-muted-foreground hover:bg-surface/60 hover:text-foreground',
                      )}
                    >
                      <span>{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <div className="px-1 pb-1.5 text-caption font-medium text-muted-foreground">网格密度</div>
              <div role="group" aria-label="图库网格列数" className="grid grid-cols-2 gap-1.5">
                {DENSITY_OPTIONS.map(([col, label]) => {
                  const activeCol = columns === col
                  return (
                    <button
                      key={col}
                      type="button"
                      aria-pressed={activeCol}
                      onClick={() => setColumns(col)}
                      className={cn(
                        'motion-press rounded-control border px-3 py-2 text-center text-ui transition-colors',
                        activeCol
                          ? 'border-border/70 bg-surface font-medium text-foreground shadow-soft'
                          : 'border-transparent bg-tonal/50 text-muted-foreground hover:bg-surface/60 hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {items.length > 0 ? (
              <div className="space-y-2.5 border-t border-border/50 pt-4">
                <div className="px-1 text-caption font-medium text-muted-foreground">批量选择</div>
                <div
                  className={cn(
                    'rounded-control border px-3 py-1 transition-colors',
                    selected.length > 0
                      ? 'border-accent/35 bg-accent-soft/50'
                      : 'border-border/70 bg-surface/75 hover:bg-surface',
                  )}
                >
                  <Checkbox
                    checked={selected.length === items.length}
                    indeterminate={selected.length > 0 && selected.length < items.length}
                    label="全选当前作品"
                    className="w-full"
                    onCheckedChange={(checked) =>
                      checked ? selectMany(items.map((asset) => asset.id)) : clearSelection()
                    }
                    disabled={busy}
                  />
                </div>
                {selected.length > 0 ? (
                  <div className="space-y-1.5 pt-1">
                    <p className="px-1 text-caption font-medium text-accent">已选 {selected.length} 件</p>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      fullWidth
                      className="rounded-control"
                      disabled={busy}
                      onClick={() => {
                        setActionError('')
                        setPendingDelete(selected)
                      }}
                      icon={<TrashIcon className={iconSize.sm} aria-hidden="true" />}
                    >
                      删除所选
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      fullWidth
                      className="rounded-control"
                      onClick={clearSelection}
                    >
                      取消选择
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </SessionSidebar>
      </aside>

      <section aria-label="作品图库画布" className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-sticky flex items-start justify-between gap-2 p-3 sm:px-5 sm:pt-3.5">
          <div
            className={cn(
              'pointer-events-auto flex items-center gap-1 rounded-pill border border-border/60 bg-surface/85 p-1 shadow-soft backdrop-blur-md',
              leftSidebarOpen && 'md:hidden',
            )}
          >
            <Button
              size="icon"
              variant="ghost"
              className="rounded-pill sm:size-8"
              aria-label={leftSidebarOpen ? '收起图库侧栏' : '展开图库侧栏'}
              aria-expanded={leftSidebarOpen}
              onClick={toggleLeftSidebar}
              icon={<SidebarSimpleIcon className={iconSize.md} aria-hidden="true" />}
            />
            <div className="hidden items-center gap-0.5 pr-1 sm:inline-flex" role="group" aria-label="快速筛选">
              {QUICK_FILTERS.map(([tab, label]) => {
                const activeTab = filters.tab === tab
                return (
                  <button
                    key={tab}
                    type="button"
                    aria-pressed={activeTab}
                    onClick={() => setTab(tab)}
                    className={cn(
                      'motion-press rounded-pill px-2.5 py-1 text-caption font-medium transition-colors',
                      activeTab
                        ? 'bg-tonal text-foreground'
                        : 'text-muted-foreground hover:bg-tonal/50 hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="pointer-events-auto ml-auto flex h-10 items-center gap-2 rounded-pill border border-border/60 bg-surface/85 px-3.5 shadow-soft backdrop-blur-md transition-[border-color,background-color,box-shadow] focus-within:border-border-focus focus-within:bg-surface focus-within:shadow-floating">
            <MagnifyingGlassIcon className={cn(iconSize.sm, 'shrink-0 text-muted-foreground')} aria-hidden="true" />
            <input
              type="text"
              role="searchbox"
              aria-label="搜索作品提示词"
              placeholder="搜索提示词…"
              value={filters.q}
              onChange={(event) => setQuery(event.target.value)}
              className="w-32 bg-transparent text-ui text-foreground placeholder:text-muted-foreground focus:outline-none sm:w-56"
            />
            {filters.q ? (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setQuery('')}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-pill text-muted-foreground transition-colors hover:bg-tonal hover:text-foreground"
              >
                <XIcon className={iconSize.xs} aria-hidden="true" />
              </button>
            ) : null}
            <span className="hidden border-l border-border/60 pl-2.5 text-caption tabular-nums text-muted-foreground sm:inline">
              {total} 件
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-20 pb-20 sm:px-6 sm:pt-16">
          <div className="space-y-5">
            {actionError ? (
              <Alert tone="danger" title="操作未完成" onDismiss={() => setActionError('')}>
                {actionError}
              </Alert>
            ) : null}
            {mode === 'mock' && filters.tab === 'video' ? (
              <Alert title="本地演示暂不提供视频样片">
                视频筛选可用，但本地演示不生成或模拟可播放的视频。切换到图片查看本地样片。
              </Alert>
            ) : null}
            {library.isError ? (
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
            ) : null}

            {library.isPending ? (
              <div aria-label="正在加载作品" aria-busy="true" className={cn('grid', gridClasses[columns])}>
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="aspect-[4/5] h-auto w-full rounded-card" />
                ))}
              </div>
            ) : !items.length && !library.isError ? (
              <div className="py-12">
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
                        <Link href={APP_ROUTES.generate} prefetch>创作第一件作品</Link>
                      </Button>
                    )
                  }
                />
              </div>
            ) : (
              <div className={cn('grid', gridClasses[columns])}>
                {items.map((asset) => {
                  const isSelected = selected.includes(asset.id)
                  const promptLabel = reusablePrompt(asset) || '未命名作品'
                  return (
                    <article
                      key={asset.id}
                      className={cn(
                        'group relative aspect-[4/5] min-w-0 overflow-hidden rounded-card bg-tonal shadow-soft transition-all hover:shadow-floating',
                        isSelected && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveId(asset.id)}
                        aria-label={`查看作品：${asset.prompt || '未命名作品'}`}
                        className="block h-full w-full overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
                      >
                        <AssetMedia key={`${asset.id}-${asset.url}`} asset={asset} />
                      </button>

                      <div
                        className={cn(
                          'absolute left-2.5 top-2.5 z-sticky rounded-pill bg-surface/90 shadow-soft backdrop-blur-sm transition-opacity',
                          isSelected || selected.length > 0
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                        )}
                      >
                        <Checkbox
                          aria-label={`选择作品：${asset.prompt || asset.id}`}
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(asset.id)}
                          disabled={busy}
                          className="size-8 min-h-0 min-w-0 rounded-pill"
                        />
                      </div>

                      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col justify-end gap-2 bg-gradient-to-t from-overlay/85 via-overlay/45 to-transparent p-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <p className="line-clamp-2 break-words text-ui font-medium text-on-media">
                          {promptLabel}
                        </p>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-caption text-on-media/80">
                            {formatDate(asset.createdAt)}
                          </span>
                          <div className="pointer-events-auto flex items-center gap-1 rounded-pill border border-border/60 bg-surface/95 p-1 shadow-floating backdrop-blur-sm">
                            {previewSource(asset) ? (
                              <Link
                                href={`${APP_ROUTES.generate}?${imageReuseSearch(asset)}`}
                                prefetch
                                aria-label="作为参考图复用"
                                onClick={() =>
                                  toast.success('已添加参考图到输入框', '可在操作台继续编辑指令或叠加更多参考图')
                                }
                                className="inline-flex size-8 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover"
                              >
                                <ImageIcon className={iconSize.sm} aria-hidden="true" />
                              </Link>
                            ) : null}
                            <Link
                              href={`${APP_ROUTES.generate}?${generationSearch(asset)}`}
                              prefetch
                              aria-label="在创作台复用提示词"
                              onClick={() =>
                                toast.info('已填入提示词草稿', '可在下方输入区编辑后发送')
                              }
                              className="inline-flex size-8 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover"
                            >
                              <SparkleIcon className={iconSize.sm} aria-hidden="true" />
                            </Link>
                            <button
                              type="button"
                              aria-label="下载作品"
                              disabled={Boolean(downloadingId)}
                              onClick={() => void handleDownload(asset)}
                              className="inline-flex size-8 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover disabled:opacity-50"
                            >
                              <ArrowDownIcon className={iconSize.sm} aria-hidden="true" />
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
                              <TrashIcon className={iconSize.sm} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}

            {library.hasNextPage ? (
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
            ) : null}
          </div>
        </div>

        {selected.length > 0 ? (
          <div className="motion-fade-in pointer-events-auto absolute bottom-5 left-1/2 z-sticky flex -translate-x-1/2 items-center gap-2.5 rounded-pill border border-border/70 bg-surface/95 px-4 py-2 shadow-floating backdrop-blur-md">
            <span role="status" className="whitespace-nowrap text-ui font-medium text-foreground">
              已选 {selected.length} 件
            </span>
            <Button
              size="sm"
              variant="danger"
              className="rounded-pill"
              disabled={busy}
              onClick={() => {
                setActionError('')
                setPendingDelete(selected)
              }}
              icon={<TrashIcon className={iconSize.sm} aria-hidden="true" />}
            >
              删除所选
            </Button>
            <Button size="sm" variant="ghost" className="rounded-pill" onClick={clearSelection}>
              取消选择
            </Button>
          </div>
        ) : null}
      </section>

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
              {previewSource(active) ? (
                <Button asChild variant="secondary" icon={<ImageIcon aria-hidden="true" />}>
                  <Link
                    href={`${APP_ROUTES.generate}?${imageReuseSearch(active)}`}
                    prefetch
                    onClick={() => {
                      setActiveId(null)
                      toast.success('已添加参考图到输入框', '可在操作台继续编辑指令或叠加更多参考图')
                    }}
                  >
                    作为参考图
                  </Link>
                </Button>
              ) : null}
              <Button asChild icon={<ArrowRightIcon aria-hidden="true" />}>
                <Link
                  href={`${APP_ROUTES.generate}?${imageReuseSearch(active, { includePrompt: true })}`}
                  prefetch
                  onClick={() => {
                    setActiveId(null)
                    toast.success('已复用图片与提示词', '已在操作台预填参考图与提示词草稿')
                  }}
                >
                  复用图片与提示词
                </Link>
              </Button>
            </>
          ) : undefined
        }
      >
        {active ? (
          <div className="min-w-0 space-y-5">
            <AssetMedia key={active.id} asset={active} detail />
            <section className="space-y-2 rounded-card border border-border bg-tonal/40 p-4">
              <h3 className="text-ui font-medium text-foreground">提示词</h3>
              <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-muted-foreground">
                {reusablePrompt(active) || '未提供提示词'}
              </p>
            </section>
            <dl className="grid grid-cols-2 gap-4 rounded-card border border-border bg-surface p-4 text-ui sm:grid-cols-4">
              <Metadata label="创建时间" value={formatDateTime(active.createdAt)} />
              <Metadata label="文件类型" value={active.mimeType} />
              <Metadata
                label="分辨率"
                value={active.width && active.height ? `${active.width} × ${active.height}` : '—'}
              />
              <Metadata label="文件大小" value={formatBytes(active.sizeBytes)} />
              {active.mediaKind === 'video' ? (
                <Metadata
                  label="时长"
                  value={active.durationSeconds === undefined ? '—' : `${active.durationSeconds} 秒`}
                />
              ) : null}
            </dl>
          </div>
        ) : null}
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
        <p className="text-ui text-muted-foreground">请确认这些作品已不再需要，或先下载保存。</p>
      </Dialog>
    </div>
  )
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-mono text-caption text-foreground">{value}</dd>
    </div>
  )
}
