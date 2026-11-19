'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  ImageIcon,
  ImagesIcon,
  MagnifyingGlassIcon,
  SparkleIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  Skeleton,
  SkeletonTile,
  controlSquare,
  iconSize,
  touchTargetSquare,
  useToast,
  type SegmentedControlItem,
} from '@/shared/components/ui'
import { queryKeys } from '@/shared/hooks/query-keys'
import { useFlipList } from '@/shared/hooks/useFlipList'
import {
  libraryItems,
  useAssetDetail,
  useAssetDownloadUrl,
  useDeleteAsset,
  useLibrary,
} from '@/shared/hooks/useLibrary'
import { APP_ROUTES, assetIdFromSearch } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import {
  formatBytes,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
} from '@/shared/lib/format'
import { isReferenceEligibleAsset } from '@/shared/lib/reference-upload'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import { useLibraryUiStore, type LibraryTab } from '@/shared/stores/library-ui-store'
import type { AssetDto } from '@/shared/types'
import {
  downloadableUrl,
  generationSearch,
  imageReuseSearch,
  reusablePrompt,
} from '../lib/library-actions'
import { AssetMedia } from './asset-media'

export interface LibraryViewProps {
  mode: WorkspaceMode
  /** 服务端从 `?asset=<uuid>` 解析的初始深链资产 ID。 */
  initialAssetId?: string | null
}

type ColumnValue = '2' | '3' | '4' | '6'

const GRID_CLASSES = {
  2: 'grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5',
  3: 'grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4',
  4: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-3.5',
  6: 'grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2.5 sm:gap-3',
} as const

const KIND_ITEMS: SegmentedControlItem<LibraryTab>[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
]

const COLUMN_ITEMS: SegmentedControlItem<ColumnValue>[] = [
  { value: '2', label: <span className="font-mono tabular-nums">2</span>, title: '2 列 · 宽松' },
  { value: '3', label: <span className="font-mono tabular-nums">3</span>, title: '3 列 · 舒适' },
  { value: '4', label: <span className="font-mono tabular-nums">4</span>, title: '4 列 · 紧凑' },
  { value: '6', label: <span className="font-mono tabular-nums">6</span>, title: '6 列 · 密集' },
]

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/svg+xml': 'svg',
}

function syncAssetQueryParam(assetId: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (url.pathname !== APP_ROUTES.library) return
  if (assetId) {
    url.searchParams.set('asset', assetId)
  } else {
    url.searchParams.delete('asset')
  }
  const nextHref = `${url.pathname}${url.search}${url.hash}`
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextHref !== currentHref) {
    window.history.replaceState(window.history.state, '', nextHref)
  }
}

export function LibraryView({ mode, initialAssetId }: LibraryViewProps) {
  const { filters, columns, setColumns, setTab, setQuery } = useLibraryUiStore()
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q.trim())

  const library = useLibrary({
    ...(filters.tab === 'all' ? {} : { kind: filters.tab }),
    q: debouncedQuery,
  })
  const items = libraryItems(library.data)

  const gridRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const gridOrderKey = `${columns}:${items.map((asset) => asset.id).join(',')}`
  useFlipList(gridRef, gridOrderKey)

  const [activeId, setActiveId] = useState<string | null>(initialAssetId ?? null)
  const [pendingDelete, setPendingDelete] = useState<string[]>([])
  const [actionError, setActionError] = useState('')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [copiedPrompt, setCopiedPrompt] = useState(false)

  const remove = useDeleteAsset()
  const download = useAssetDownloadUrl()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const listActive = activeId ? (items.find((asset) => asset.id === activeId) ?? null) : null
  const detailQuery = useAssetDetail(activeId && !listActive ? activeId : null)
  const active = listActive ?? detailQuery.data ?? null
  const activeReferenceEligible = active ? isReferenceEligibleAsset(active) : false
  const activePrompt = active ? reusablePrompt(active) : ''

  const busy = remove.isPending
  const filtered = Boolean(filters.q.trim() || filters.tab !== 'all')
  const total = library.data?.pages[0]?.total ?? 0
  const resultsRefreshing =
    filters.q.trim() !== debouncedQuery ||
    library.isPlaceholderData ||
    (library.isFetching && !library.isPending && !library.isFetchingNextPage)

  const openAsset = useCallback((assetId: string) => {
    setActiveId(assetId)
    syncAssetQueryParam(assetId)
  }, [])

  const closeAsset = useCallback(() => {
    setActiveId(null)
    syncAssetQueryParam(null)
  }, [])

  // 同步外部路由传入的 `?asset=<uuid>` 变化（如从其他页面点击深链跳转过来）。
  const prevInitialAssetIdRef = useRef<string | null | undefined>(initialAssetId)
  useEffect(() => {
    if (prevInitialAssetIdRef.current === initialAssetId) return
    prevInitialAssetIdRef.current = initialAssetId
    setActiveId(initialAssetId ?? null)
  }, [initialAssetId])

  // 客户端兜底读取 `?asset=<uuid>`，并响应浏览器前进/后退。
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (initialAssetId === undefined) {
      const fromUrl = assetIdFromSearch(window.location.search)
      if (fromUrl) setActiveId(fromUrl)
    }
    const onPopState = () => {
      setActiveId(assetIdFromSearch(window.location.search))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [initialAssetId])

  // 筛选条件改变时收起已打开的灯箱（不干扰首屏 `?asset=` 深链）。
  const prevFilterKeyRef = useRef(`${filters.tab}:${filters.q}`)
  useEffect(() => {
    const nextFilterKey = `${filters.tab}:${filters.q}`
    if (prevFilterKeyRef.current === nextFilterKey) return
    prevFilterKeyRef.current = nextFilterKey
    closeAsset()
  }, [filters.q, filters.tab, closeAsset])

  // 搜索输入 300ms 防抖。
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(filters.q.trim()), 300)
    return () => window.clearTimeout(timeout)
  }, [filters.q])

  // 切换资产时重置复制反馈状态。
  useEffect(() => {
    setCopiedPrompt(false)
  }, [activeId])

  useEffect(() => {
    if (!copiedPrompt) return
    const timer = window.setTimeout(() => setCopiedPrompt(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copiedPrompt])

  const { hasNextPage, isFetchingNextPage, isError: isLibraryError, fetchNextPage } = library

  // 触底自动加载下一页，同时保留手动「加载更多」按钮。
  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (!sentinel || !hasNextPage || isFetchingNextPage || isLibraryError) return
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage()
        }
      },
      { rootMargin: '240px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, isLibraryError, fetchNextPage])

  function updateQuery(query: string) {
    setQuery(query)
    if (!query.trim()) setDebouncedQuery('')
  }

  function resetFilters() {
    updateQuery('')
    setTab('all')
  }

  function handleColumnsChange(next: ColumnValue) {
    setColumns(Number(next) as 2 | 3 | 4 | 6)
  }

  async function handleCopyPrompt(promptText: string) {
    if (!promptText) return
    try {
      await navigator.clipboard.writeText(promptText)
      setCopiedPrompt(true)
      toast.success('已复制提示词')
    } catch {
      toast.error('复制失败', '请手动选中提示词文本进行复制。')
    }
  }

  async function handleDelete() {
    if (busy || !pendingDelete.length) return
    setActionError('')
    try {
      await remove.mutateAsync(pendingDelete[0])
      if (activeId && pendingDelete.includes(activeId)) {
        closeAsset()
      }
      setPendingDelete([])
      toast.success('作品已删除')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '未能完成删除，请刷新列表后重试。')
      setPendingDelete([])
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
      anchor.download = `musecanvas-${asset.id.replace(/[^a-zA-Z0-9_-]/g, '')}.${DOWNLOAD_EXTENSIONS[signed.mimeType] || 'bin'}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
      toast.success('已开始下载')
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败，请稍后重试。'
      setActionError(message)
      toast.error('无法下载作品', message)
    } finally {
      setDownloadingId(null)
    }
  }

  const statusText = library.isPending
    ? '加载中…'
    : resultsRefreshing
      ? '更新中…'
      : `${filtered ? '找到' : '共'} ${formatCount(total)} 件`

  return (
    <div data-workspace-mode={mode} className="flex w-full flex-col gap-6">
      <PageHeader
        title="作品图库"
        description="浏览、检索与管理你在创作台生成的图片与视频资产。"
        actions={
          <Button asChild icon={<SparkleIcon weight="bold" aria-hidden="true" />}>
            <Link href={APP_ROUTES.generate} prefetch>
              前往创作台
            </Link>
          </Button>
        }
      />

      <Card variant="surface" density="compact" className="gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative min-w-0 flex-1 md:max-w-sm">
            <MagnifyingGlassIcon
              weight="bold"
              aria-hidden="true"
              className={cn(iconSize.sm, 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground')}
            />
            <Input
              type="search"
              role="searchbox"
              size="md"
              aria-label="搜索作品提示词"
              placeholder="搜索提示词关键词…"
              value={filters.q}
              onChange={(event) => updateQuery(event.target.value)}
              className={cn('pl-9', filters.q && 'pr-9')}
            />
            {filters.q ? (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => updateQuery('')}
                className={cn(
                  'absolute right-1.5 top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-pill text-muted-foreground transition-colors hover:bg-tonal hover:text-foreground',
                  controlSquare.xs,
                )}
              >
                <XIcon weight="bold" className={iconSize.xs} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 sm:justify-end">
            <SegmentedControl
              label="作品类型筛选"
              size="sm"
              items={KIND_ITEMS}
              value={filters.tab}
              onChange={setTab}
            />
            <SegmentedControl
              label="网格列数"
              size="sm"
              items={COLUMN_ITEMS}
              value={String(columns) as ColumnValue}
              onChange={handleColumnsChange}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5">
          <div role="status" className="inline-flex items-center gap-2 text-caption text-muted-foreground">
            {resultsRefreshing ? (
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-pill bg-accent" />
            ) : null}
            <span className="font-mono tabular-nums">{statusText}</span>
          </div>
          {filtered ? (
            <Button variant="ghost" size="xs" onClick={resetFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>
      </Card>

      {actionError ? (
        <Alert tone="danger" role="alert" title="操作未完成" onDismiss={() => setActionError('')}>
          {actionError}
        </Alert>
      ) : null}

      {mode === 'mock' && filters.tab === 'video' ? (
        <Alert tone="info" title="本地演示暂不提供视频样片">
          视频筛选可用，但本地演示不生成或模拟可播放的视频。切换到「图片」即可查看本地样片。
        </Alert>
      ) : null}

      {library.isError ? (
        <Alert
          tone="danger"
          role="alert"
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
        <div
          aria-label="正在加载作品"
          aria-busy="true"
          className={cn('grid', GRID_CLASSES[columns])}
        >
          {Array.from({ length: 8 }, (_, index) => (
            <SkeletonTile key={index} className="aspect-[4/5] rounded-card" />
          ))}
        </div>
      ) : !items.length && !library.isError ? (
        <Card variant="surface">
          <EmptyState
            icon={ImagesIcon}
            title={filtered ? '没有找到匹配的作品' : '图库暂无作品'}
            description={
              filtered
                ? '试试其他关键词，或清除筛选查看全部作品。'
                : '前往创作台完成第一次生成，图片与视频会自动收录到这里。'
            }
            action={
              filtered ? (
                <Button variant="secondary" onClick={resetFilters}>
                  清除筛选
                </Button>
              ) : (
                <Button asChild icon={<SparkleIcon weight="bold" aria-hidden="true" />}>
                  <Link href={APP_ROUTES.generate} prefetch>
                    创作第一件作品
                  </Link>
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div
          ref={gridRef}
          aria-busy={resultsRefreshing || undefined}
          className={cn('grid', GRID_CLASSES[columns])}
        >
          {items.map((asset) => {
            const promptLabel = reusablePrompt(asset) || '未命名作品'
            const referenceEligible = isReferenceEligibleAsset(asset)
            return (
              <article key={asset.id} data-flip-key={asset.id} className="min-w-0">
                <Card
                  density="none"
                  variant="surface"
                  className="group relative aspect-[4/5] w-full overflow-hidden transition-[border-color,box-shadow,transform] duration-[var(--motion-base)] ease-out hover:-translate-y-0.5 hover:border-border-control hover:shadow-floating"
                >
                  <button
                    type="button"
                    onClick={() => openAsset(asset.id)}
                    aria-label={`查看作品：${promptLabel}`}
                    className="block h-full w-full overflow-hidden text-left"
                  >
                    <AssetMedia key={`${asset.id}-${asset.url}`} asset={asset} />
                  </button>

                  <div className="media-tile-actions media-scrim pointer-events-none absolute inset-x-0 bottom-0 flex flex-col justify-end gap-2 p-2.5 sm:p-3.5">
                    <p className="line-clamp-2 break-words text-ui font-medium text-on-media">
                      {promptLabel}
                    </p>
                    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                      <span className="mr-auto font-mono text-caption tabular-nums text-on-media/85">
                        {formatDate(asset.createdAt)}
                      </span>
                      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-1 rounded-pill border border-border/70 bg-surface/95 p-1 shadow-floating backdrop-blur-sm">
                        {referenceEligible ? (
                          <Link
                            href={`${APP_ROUTES.generate}?${imageReuseSearch(asset)}`}
                            prefetch
                            aria-label="以此为参考图创作"
                            title="以此为参考图创作"
                            onClick={() =>
                              toast.success('已添加参考图到输入框', '可在创作台继续编辑指令或叠加更多参考图')
                            }
                            className={cn(
                              'inline-flex shrink-0 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover',
                              controlSquare.sm,
                              touchTargetSquare,
                            )}
                          >
                            <ImageIcon weight="regular" className={iconSize.sm} aria-hidden="true" />
                          </Link>
                        ) : null}
                        <Link
                          href={`${APP_ROUTES.generate}?${generationSearch(asset)}`}
                          prefetch
                          aria-label="复用提示词"
                          title="复用提示词"
                          onClick={() =>
                            toast.info('已填入提示词草稿', '可在创作台输入区编辑后发送')
                          }
                          className={cn(
                            'inline-flex shrink-0 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover',
                            controlSquare.sm,
                            touchTargetSquare,
                          )}
                        >
                          <SparkleIcon weight="regular" className={iconSize.sm} aria-hidden="true" />
                        </Link>
                        <button
                          type="button"
                          aria-label="下载作品"
                          title="下载作品"
                          disabled={Boolean(downloadingId)}
                          onClick={() => void handleDownload(asset)}
                          className={cn(
                            'inline-flex shrink-0 items-center justify-center rounded-pill text-foreground transition-colors hover:bg-tonal-hover disabled:is-disabled',
                            controlSquare.sm,
                            touchTargetSquare,
                          )}
                        >
                          <ArrowDownIcon weight="regular" className={iconSize.sm} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label="删除作品"
                          title="删除作品"
                          disabled={busy}
                          onClick={() => {
                            setActionError('')
                            setPendingDelete([asset.id])
                          }}
                          className={cn(
                            'inline-flex shrink-0 items-center justify-center rounded-pill text-danger transition-colors hover:bg-danger-soft disabled:is-disabled',
                            controlSquare.sm,
                            touchTargetSquare,
                          )}
                        >
                          <TrashIcon weight="regular" className={iconSize.sm} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                </Card>
              </article>
            )
          })}
        </div>
      )}

      {library.hasNextPage ? (
        <div ref={loadMoreRef} className="flex justify-center pt-2">
          <Button
            variant="secondary"
            loading={library.isFetchingNextPage}
            onClick={() => void library.fetchNextPage()}
          >
            加载更多作品
          </Button>
        </div>
      ) : null}

      <Dialog
        open={Boolean(activeId)}
        onClose={closeAsset}
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
              {activeReferenceEligible ? (
                <Button asChild variant="secondary" icon={<ImageIcon aria-hidden="true" />}>
                  <Link
                    href={`${APP_ROUTES.generate}?${imageReuseSearch(active)}`}
                    prefetch
                    onClick={() => {
                      closeAsset()
                      toast.success('已添加参考图到输入框', '可在创作台继续编辑指令或叠加更多参考图')
                    }}
                  >
                    以此为参考图创作
                  </Link>
                </Button>
              ) : null}
              <Button asChild icon={<SparkleIcon aria-hidden="true" />}>
                <Link
                  href={`${APP_ROUTES.generate}?${generationSearch(active)}`}
                  prefetch
                  onClick={() => {
                    closeAsset()
                    toast.info('已填入提示词草稿', '可在创作台输入区编辑后发送')
                  }}
                >
                  复用提示词
                </Link>
              </Button>
            </>
          ) : undefined
        }
      >
        {active ? (
          <div className="min-w-0 space-y-5">
            <AssetMedia key={active.id} asset={active} detail />

            <section className="space-y-2 border-t border-border/70 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-ui font-medium text-foreground">提示词</h3>
                  <Badge tone={active.mediaKind === 'video' ? 'info' : 'neutral'}>
                    {active.mediaKind === 'video' ? '视频' : '图片'}
                  </Badge>
                </div>
                {activePrompt ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCopyPrompt(activePrompt)}
                    icon={
                      copiedPrompt ? (
                        <CheckIcon weight="bold" aria-hidden="true" />
                      ) : (
                        <CopyIcon aria-hidden="true" />
                      )
                    }
                  >
                    {copiedPrompt ? '已复制' : '复制提示词'}
                  </Button>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap break-words text-ui leading-relaxed text-muted-foreground">
                {activePrompt || '未提供提示词'}
              </p>
            </section>

            <dl className="grid grid-cols-2 gap-4 border-t border-border/70 pt-4 sm:grid-cols-4">
              <Metadata label="创建时间" value={formatDateTime(active.createdAt)} />
              <Metadata label="文件类型" value={active.mimeType || '—'} />
              <Metadata
                label="分辨率"
                value={active.width && active.height ? `${active.width} × ${active.height}` : '—'}
              />
              <Metadata label="文件大小" value={formatBytes(active.sizeBytes)} />
              {active.mediaKind === 'video' ? (
                <Metadata label="时长" value={formatDuration(active.durationSeconds)} />
              ) : null}
            </dl>
          </div>
        ) : detailQuery.isError ? (
          <Alert
            tone="danger"
            role="alert"
            title="无法加载该作品"
            action={
              <Button size="sm" variant="secondary" onClick={() => void detailQuery.refetch()}>
                重试
              </Button>
            }
          >
            {detailQuery.error instanceof Error ? detailQuery.error.message : '作品可能已被删除或暂不可访问。'}
          </Alert>
        ) : (
          <div aria-label="正在加载作品详情" aria-busy="true" className="space-y-4">
            <SkeletonTile className="aspect-video w-full rounded-card" />
            <div className="space-y-2 pt-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
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
        <p className="text-ui text-muted-foreground">请确认这些作品已不再需要，或先下载保存。</p>
      </Dialog>
    </div>
  )
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-mono text-caption tabular-nums text-foreground">{value}</dd>
    </div>
  )
}
