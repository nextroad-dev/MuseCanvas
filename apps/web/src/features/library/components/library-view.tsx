'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState } from 'react'
import type { CSSProperties } from 'react'
import { usePathname,
  useRouter,
  useSearchParams } from 'next/navigation'
import {
  DownloadSimpleIcon as Download,
  ArrowClockwiseIcon as RefreshCw,
  MagnifyingGlassIcon as SearchIcon,
  TrashIcon as Trash2,
  XIcon as X,
  MagnifyingGlassPlusIcon as ZoomIn,
  PlusIcon,
  } from '@phosphor-icons/react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Skeleton,
  SkeletonTile,
  Tabs,
  buttonVariants,
  useToast,
  controlSquare,
  iconSize,
} from '@/shared/components/ui'
import type { TabItem } from '@/shared/components/ui'
import { ContentFrame } from '@/shared/components/content-frame'
import { MediaFrame } from '@/shared/components/media-frame'
import { api } from '@/shared/services/api'
import { useLibraryUiStore } from '@/shared/stores/library-ui-store'
import type { LibraryFilterKind } from '@/shared/stores/library-ui-store'
import {
  libraryPageItems,
  useDeleteAsset,
  useLibraryInfiniteQuery,
} from '@/shared/hooks/useLibrary'
import { assetPlaybackUrl, assetPreviewUrl, isVideoAsset } from '@/shared/types'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'
import { formatDate } from '@/shared/lib/format'
import { AssetLightbox } from './asset-lightbox'
import { deleteSelectedAssets, libraryGridClass as gridClass } from './workspace-page-state'

/** Segmented control values, mirroring `LibraryFilterKind`. Fed to `Tabs`, whose
 *  `tablist` / `tab` / `tabpanel` semantics replace the old `aria-pressed` row. */
const FILTER_TABS: TabItem[] = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图像' },
  { id: 'video', label: '视频' },
]

/** Column count is a preference rather than a filter, so it stays a native `Select`. */
const COLUMN_OPTIONS = [2, 3, 4, 6] as const

/** Search & Filter 模式: 搜索输入有 debounce（300ms）. */
const SEARCH_DEBOUNCE_MS = 300

/** Tiles painted while the first page is in flight; eight fills two 4-column rows. */
const SKELETON_TILES = 8

/** Cells past this index share one delay: `.motion-stagger` clamps at 12 steps,
 *  so the tail of a 50-row page must not advertise a wait it will never pay. */
const STAGGER_CLAMP = 8

/**
 * states.md §5 wants 无权限 told apart from 加载失败, and `GET /api/library` can answer
 * both (an expired session reaches `guard.ts`, not the layout redirect). The shared
 * hook throws `new Error(res.error?.message)`, so `error.code` never arrives here and
 * the server's own wording is the only signal — anything unrecognised falls back to
 * the retry branch, which is always a correct offer.
 */
function isPermissionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /无权|未登录|无权限|FORBIDDEN|UNAUTHORIZED/i.test(message)
}

export function LibraryView() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Per-field selectors: a bare store destructure re-renders on any field change.
  const selectedAssetIds = useLibraryUiStore((s) => s.selectedAssetIds)
  const toggleSelectAsset = useLibraryUiStore((s) => s.toggleSelectAsset)
  const selectAllAssets = useLibraryUiStore((s) => s.selectAllAssets)
  const clearSelectedAssets = useLibraryUiStore((s) => s.clearSelectedAssets)
  const columnCount = useLibraryUiStore((s) => s.columnCount)
  const setColumnCount = useLibraryUiStore((s) => s.setColumnCount)
  const filterKind = useLibraryUiStore((s) => s.filterKind)
  const setFilterKind = useLibraryUiStore((s) => s.setFilterKind)
  const searchQuery = useLibraryUiStore((s) => s.searchQuery)
  const setSearchQuery = useLibraryUiStore((s) => s.setSearchQuery)
  const previewAssetId = useLibraryUiStore((s) => s.previewAssetId)
  const setPreviewAssetId = useLibraryUiStore((s) => s.setPreviewAssetId)

  // `appliedQuery` is the *debounced* term: it is what the request carries, what the
  // removable tag shows and what the URL is written from, so the three can never
  // disagree while the user is still typing.
  const [appliedQuery, setAppliedQuery] = useState(() => searchParams.get('q')?.trim() ?? '')
  const [targetPages, setTargetPages] = useState(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const hydratedRef = useRef(false)
  const forwardFailedRef = useRef(false)

  // Deep link in, once: the URL is the shareable source of truth for the filters and
  // the store holds them for this render pass. `q` already reached `appliedQuery`
  // through the initialiser, so only the type filter and the depth need reading.
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const urlKind = searchParams.get('type')
    if (urlKind === 'image' || urlKind === 'video') setFilterKind(urlKind)
    const urlQuery = searchParams.get('q')?.trim() ?? ''
    if (urlQuery && urlQuery !== searchQuery) setSearchQuery(urlQuery)
    const urlPage = Number(searchParams.get('page'))
    if (Number.isFinite(urlPage) && urlPage > 1) setTargetPages(urlPage)
  }, [searchParams, searchQuery, setFilterKind, setSearchQuery])

  // Debounce the live input into the committed term.
  useEffect(() => {
    if (!hydratedRef.current) return
    const next = searchQuery.trim()
    if (next === appliedQuery) return
    const timer = window.setTimeout(() => setAppliedQuery(next), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchQuery, appliedQuery])

  // One keyset page at a time (see GET /api/library). `total` comes from the first
  // page because it counts the whole predicate, not the window, so the media kind
  // must be part of that predicate or "共 N 个作品" keeps counting every kind.
  const queryParams = useMemo(
    () => ({
      limit: 30,
      q: appliedQuery || undefined,
      kind: filterKind === 'all' ? undefined : filterKind,
    }),
    [appliedQuery, filterKind],
  )
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useLibraryInfiniteQuery(queryParams)
  const assets = useMemo(() => libraryPageItems(data), [data])
  const total = data?.pages[0]?.total ?? assets.length
  const pageCount = data?.pages.length ?? 1
  const deleteMutation = useDeleteAsset()
  const [batchDeleting, setBatchDeleting] = useState(false)
  const batchDeletingRef = useRef(false)
  const [deleteFeedback, setDeleteFeedback] = useState<string | null>(null)
  const [resignedUrls, setResignedUrls] = useState<Record<string, string>>({})
  const resignAttempted = useRef(new Set<string>())

  const resignPreview = useCallback(async (assetId: string) => {
    if (resignAttempted.current.has(assetId)) return
    resignAttempted.current.add(assetId)
    try {
      const response = await api.getAssetDownloadUrl(assetId)
      const url = response.success ? response.data?.url : undefined
      if (url) {
        setResignedUrls((urls) => ({ ...urls, [assetId]: url }))
      }
    } catch {
      // The tile still offers the detail viewer's explicit retry action.
    }
  }, [])

  // The server already filters by kind; the local pass only guards the frame where
  // the previous query's pages are still shown while the new one is in flight.
  const visibleAssets =
    filterKind === 'all'
      ? assets
      : assets.filter((asset) => isVideoAsset(asset) === (filterKind === 'video'))

  // Every filter change resets the keyset window, so a depth remembered from the
  // previous query must not be chased into the new one.
  // The selection is dropped too: a bulk delete must only ever act on tiles the user
  // can currently see, never on ones a filter has hidden.
  useEffect(() => {
    setTargetPages(0)
    forwardFailedRef.current = false
    clearSelectedAssets()
    setDeleteFeedback(null)
  }, [appliedQuery, filterKind, clearSelectedAssets])

  // Escape / arrows / focus restore all live in `useDialog` behind the lightbox.
  // These two callbacks are stable so the dialog never re-binds its window keydown.
  const closePreview = useCallback(() => setPreviewAssetId(null), [setPreviewAssetId])
  const openPreview = useCallback((assetId: string) => setPreviewAssetId(assetId), [setPreviewAssetId])

  const isAllSelected =
    visibleAssets.length > 0 && visibleAssets.every((asset) => selectedAssetIds.includes(asset.id))
  const isAnySelected = selectedAssetIds.length > 0
  const hasActiveFilter = appliedQuery !== '' || filterKind !== 'all'

  const clearQuery = useCallback(() => {
    setSearchQuery('')
    setAppliedQuery('')
  }, [setSearchQuery])

  const clearFilters = useCallback(() => {
    setSearchQuery('')
    setAppliedQuery('')
    setFilterKind('all')
  }, [setSearchQuery, setFilterKind])

  const toast = useToast()

  // Destructive deletes are confirmed in the shared `Dialog`, never in a native
  // browser dialog, which cannot name the object or the consequence.
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const deleteTarget = deleteTargetId ? assets.find((asset) => asset.id === deleteTargetId) ?? null : null

  async function confirmBatchDelete() {
    if (batchDeletingRef.current) return
    batchDeletingRef.current = true
    setBatchDeleting(true)
    const targets = [...selectedAssetIds]
    try {
      const { succeeded, failed } = await deleteSelectedAssets(targets, (id) => deleteMutation.mutateAsync(id))
      // Only remove successful IDs: changing a filter during the request must not
      // resurrect its old selection, and failed rows remain selected for a retry.
      const currentSelection = useLibraryUiStore.getState().selectedAssetIds
      selectAllAssets(currentSelection.filter((id) => !succeeded.includes(id)))
      setDeleteFeedback(failed.length
        ? `已删除 ${succeeded.length} 个作品，${failed.length} 个删除失败。失败项仍保留选择，请重试。`
        : null)
      toast.push({ title: failed.length ? '部分作品未能删除' : `已删除 ${succeeded.length} 个作品`, variant: failed.length ? 'error' : 'success' })
    } finally {
      batchDeletingRef.current = false
      setBatchDeleting(false)
      setBatchDeleteOpen(false)
    }
  }

  function confirmSingleDelete() {
    const assetId = deleteTargetId
    if (!assetId) return
    // The dialog stays open while the request runs so its loading state is seen.
    deleteMutation.mutate(assetId, {
      onSettled: () => setDeleteTargetId(null),
      onSuccess: () => {
        selectAllAssets(useLibraryUiStore.getState().selectedAssetIds.filter((id) => id !== assetId))
        toast.push({ title: '作品已删除', variant: 'success' })
      },
      onError: (err: Error) =>
        toast.push({
          title: '删除失败',
          description: `${err.message}。请刷新后重试。`,
          variant: 'error',
        }),
    })
  }

  // Shareable filters (components.md → Search & Filter 模式: 筛选条件反映在 URL 参数可分享).
  //
  // Two effects, because `pageCount` is read out of the *current* query result: at
  // the moment `appliedQuery`/`filterKind` change it still describes the previous
  // query. One effect covering all three keys would therefore briefly write the old
  // depth into the new filter's URL (`?q=cat&page=3` for a search with exactly one
  // page). Filters own `q`/`type`; the depth is re-derived from the data below.
  //
  // `page` is dropped here only when the filter genuinely moved away from what the
  // URL says (the "changed" test), not merely because this effect ran. That keeps a
  // restored `?page=N` link intact while the depth effect walks it forward, and it
  // avoids depending on `targetPages` — which is reset mid-flight and would make
  // this effect fire a spurious, page-destroying write as the walk completed.
  useEffect(() => {
    if (!hydratedRef.current) return
    const urlQuery = searchParams.get('q') ?? ''
    const urlKind = searchParams.get('type') ?? 'all'
    const filterMoved = urlQuery !== appliedQuery || urlKind !== filterKind
    const next = new URLSearchParams(searchParams.toString())
    if (appliedQuery) next.set('q', appliedQuery)
    else next.delete('q')
    if (filterKind !== 'all') next.set('type', filterKind)
    else next.delete('type')
    if (filterMoved) next.delete('page')
    const serialized = next.toString()
    if (serialized === searchParams.toString()) return
    router.replace(serialized ? `${pathname}?${serialized}` : pathname, { scroll: false })
    // `searchParams` is read as the merge base only; depending on it would make this
    // effect re-run on its own navigation and fight the URL it just wrote.
  }, [appliedQuery, filterKind, pathname, router])

  // Depth is written from the data, and only while it means something: `?page=1` is
  // the default state, so it is dropped and a shared link carries no redundant
  // parameter. Held back while a restored link is still walking forward.
  useEffect(() => {
    if (!hydratedRef.current) return
    if (targetPages > 0) return
    const next = new URLSearchParams(searchParams.toString())
    if (pageCount > 1) next.set('page', String(pageCount))
    else next.delete('page')
    const serialized = next.toString()
    if (serialized === searchParams.toString()) return
    router.replace(serialized ? `${pathname}?${serialized}` : pathname, { scroll: false })
    // See the note above on `searchParams`.
  }, [pageCount, targetPages, pathname, router])

  // `?page=3` is a keyset *depth*, not a number the API can jump to, so a restored
  // link walks forward. A failed hop stops the walk rather than retrying it on every
  // render; the refresh banner is then the user's way back in.
  useEffect(() => {
    if (targetPages === 0) return
    if (pageCount >= targetPages || !hasNextPage) {
      setTargetPages(0)
      return
    }
    if (isFetchingNextPage || forwardFailedRef.current) return
    void fetchNextPage().catch(() => {
      forwardFailedRef.current = true
    })
  }, [targetPages, pageCount, hasNextPage, isFetchingNextPage, fetchNextPage])

  /** The whole results region, passed to every `Tabs` item as its panel body. `lazy`
   *  keeps only the active panel's copy mounted, so one grid ever exists, while all
   *  three `tabpanel` nodes stay in the DOM for `aria-controls` to resolve. */
  const results = (
    <>
      {/* Loading: the grid's own geometry, not a spinner. `aria-busy` sits on the
          region and every placeholder is `aria-hidden` inside `SkeletonTile`. */}
      {isLoading ? (
        <div ref={gridRef} className={`grid gap-4 sm:gap-5 ${gridClass(columnCount)}`} aria-busy>
          {Array.from({ length: SKELETON_TILES }, (_, index) => (
            <div key={index} className="overflow-hidden rounded-card bg-surface">
              <div className="aspect-square">
                <SkeletonTile />
              </div>
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
          <p className="sr-only">正在加载作品…</p>
        </div>
      ) : isError && !data ? (
        isPermissionFailure(error) ? (
          <EmptyState
            variant="no-permission"
            objectName="作品图库"
            description="登录状态已失效，或你没有访问该作品库的权限。请重新登录后再试。"
            action={
              <Button variant="secondary" onClick={() => router.push('/login')}>
                重新登录
              </Button>
            }
          />
        ) : (
          <EmptyState
            variant="error"
            objectName="作品图库"
            description={`无法获取作品列表：${error instanceof Error ? error.message : '网络或服务端错误'}。请检查网络后刷新重试。`}
            onAction={() => void refetch()}
          />
        )
      ) : visibleAssets.length > 0 ? (
        <div ref={gridRef} className={`grid gap-4 sm:gap-5 ${gridClass(columnCount)}`}>
          {visibleAssets.map((asset, index) => {
            const selected = selectedAssetIds.includes(asset.id)
            // Tab switches replay the entrance, but only the first screen earns
            // it: past STAGGER_CLAMP there is no `motion-reveal` at all, so the
            // tail never advertises a wait it will never pay.
            const staged = index < STAGGER_CLAMP
            return (
              <div
                key={asset.id}
                style={staged ? ({ '--stagger-index': String(index) } as CSSProperties) : undefined}
                className={`group relative overflow-hidden rounded-card bg-surface ${
                  staged ? 'motion-reveal motion-stagger' : ''
                } ${
                  selected ? 'ring-2 ring-primary' : ''
                }`}
              >
                {/* `src` stays the original: it is what a failed preview retries
                    against and what the tile's download link serves. */}
                <div className="aspect-square overflow-hidden bg-tonal">
                  <MediaFrame
                    src={resignedUrls[asset.id] ?? assetPlaybackUrl(asset)}
                    previewSrc={resignedUrls[asset.id] ? undefined : assetPreviewUrl(asset)}
                    onMediaError={() => void resignPreview(asset.id)}
                    kind={isVideoAsset(asset) ? 'video' : 'image'}
                    alt={asset.prompt || 'Generated asset'}
                    layout="tile"
                    durationSeconds={asset.durationSeconds}
                    width={asset.width}
                    height={asset.height}
                    hasAudio={asset.hasAudio}
                    showControls={false}
                    className="h-full w-full object-cover"
                  />
                </div>

                {/* Top-right selection checkbox; touch screens have no hover, so it stays visible there */}
                <div className="absolute right-2 top-2 rounded-control bg-surface/95 p-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  <Checkbox
                    checked={selected}
                    disabled={batchDeleting}
                    onCheckedChange={() => toggleSelectAsset(asset.id)}
                    aria-label={selected ? '取消选择该作品' : '选择该作品'}
                  />
                </div>

                <div className="flex flex-col gap-1 p-3">
                  <p className="line-clamp-1 min-h-5 break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                    {asset.prompt || '无提示词'}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatDate(asset.createdAt)}
                    </span>
                    {/* Hidden until the tile is hovered or any control inside it has keyboard focus;
                        touch screens always show them. */}
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        onClick={() => openPreview(asset.id)}
                        aria-label="放大查看该作品"
                        icon={<ZoomIn weight="bold" aria-hidden="true" />}
                      />
                      {/* Navigation + download, so a real link wears the chip rather
                          than a button that would only pretend to be one. */}
                      <a
                        href={resignedUrls[asset.id] ?? assetPlaybackUrl(asset)}
                        download
                        target="_blank"
                        rel="noreferrer"
                        aria-label="下载该作品"
                        className={buttonVariants({ variant: 'ghost', size: 'sm', iconOnly: true })}
                      >
                        <Download weight="bold" aria-hidden="true" className={iconSize.sm} />
                      </a>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTargetId(asset.id)}
                        aria-label="删除该作品"
                        disabled={batchDeleting}
                        className="text-danger"
                        icon={<Trash2 weight="bold" aria-hidden="true" />}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : hasActiveFilter ? (
        /* Tiles are loaded but every one is hidden: a filter with no results, not an
           empty library. The wording follows whichever conditions are on. */
        <EmptyState
          variant="no-results"
          objectName="作品"
          keyword={appliedQuery || undefined}
          title={appliedQuery ? undefined : '没有符合当前筛选条件的作品'}
          description={
            appliedQuery
              ? undefined
              : '尝试调整或清除筛选条件以查看更多内容。'
          }
          onAction={clearFilters}
        />
      ) : (
        <EmptyState
          variant="first-use"
          objectName="作品"
          title="欢迎使用作品图库"
          description="在创作台生成图像或视频后，所有作品都会归档在这里。点击下方按钮开始。"
          onAction={() => router.push(GENERATE_ROUTE)}
        />
      )}

      {/* The load-more control lives inside the panel but outside the grid branch on
          purpose: with a kind filter active every loaded tile can be hidden while
          older work is still one request away, and a control inside the grid would
          vanish with it. */}
      {!isLoading && hasNextPage ? (
        <div className="flex flex-wrap items-center justify-center gap-3 pb-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void fetchNextPage()}
            loading={isFetchingNextPage}
            icon={<RefreshCw weight="bold" aria-hidden="true" />}
          >
            加载更多作品
          </Button>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            已加载 {visibleAssets.length} / {total}
          </p>
        </div>
      ) : null}
    </>
  )

  const filterTabs: TabItem[] = FILTER_TABS.map((tab) => ({ ...tab, content: results }))

  const selectAllCheckbox = (
    <Checkbox
      checked={isAllSelected}
      indeterminate={isAnySelected && !isAllSelected}
      disabled={batchDeleting}
      label={isAllSelected ? '取消选择已加载作品' : '选择已加载作品'}
      onCheckedChange={(checked) => checked
        ? selectAllAssets(visibleAssets.map((asset) => asset.id))
        : clearSelectedAssets()}
    />
  )

  return (
    <ContentFrame className="motion-page-enter flex min-h-0 flex-1 flex-col gap-6 py-6 md:py-8">
      <div className="flex min-w-0 flex-col gap-6">
        {/* Gallery header: title + count on the left, filter tabs on the right. */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title font-normal text-foreground">作品图库</h1>
            <p className="text-sm text-muted-foreground">
              {isLoading ? '正在读取作品…' : !data ? '作品暂时无法读取' : `已加载 ${visibleAssets.length} / ${total} 个已生成作品`}
            </p>
          </div>
          <Tabs
            variant="segment"
            tabs={filterTabs}
            value={filterKind}
            onValueChange={(id) => setFilterKind(id as LibraryFilterKind)}
            lazy
            className="ml-auto"
            aria-label="作品类型筛选"
          />
        </header>

        {/* Search & density toolbar */}
        <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="relative w-full min-w-0 sm:max-w-md">
            <SearchIcon weight="bold"
              aria-hidden="true"
              className={`pointer-events-none absolute left-3 top-1/2 ${iconSize.sm} -translate-y-1/2 text-muted-foreground`}
            />
            <Input
              type="search"
              aria-label="按提示词搜索作品"
              placeholder="搜索提示词"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-10"
            />
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              网格密度
              <Select
                aria-label="桌面网格密度"
                className="w-28"
                value={String(columnCount)}
                onChange={(event) => setColumnCount(Number(event.target.value) as 2 | 3 | 4 | 6)}
              >
                {COLUMN_OPTIONS.map((cols) => (
                  <option key={cols} value={String(cols)}>{cols} 列</option>
                ))}
              </Select>
            </label>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw weight="bold" aria-hidden="true" />}
              loading={isFetching && !isFetchingNextPage}
              onClick={() => void refetch()}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<PlusIcon weight="bold" aria-hidden="true" />}
              onClick={() => router.push(GENERATE_ROUTE)}
            >
              去创作
            </Button>
          </div>
        </div>

        {hasActiveFilter ? (
          <div className="flex flex-wrap items-center gap-2">
            {appliedQuery ? (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1 break-all">
                <Badge tone="neutral" className="min-w-0" icon={<SearchIcon weight="bold" aria-hidden="true" />}>
                  关键词：{appliedQuery}
                </Badge>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="清除关键词筛选"
                  onClick={clearQuery}
                  className={`${controlSquare.md} min-h-[var(--control-md)]`}
                  icon={<X weight="bold" aria-hidden="true" />}
                />
              </span>
            ) : null}
            {filterKind !== 'all' ? (
              <span className="inline-flex items-center gap-1">
                <Badge tone="neutral">
                  类型：{FILTER_TABS.find((tab) => tab.id === filterKind)?.label ?? filterKind}
                </Badge>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="清除作品类型筛选"
                  onClick={() => setFilterKind('all')}
                  className={`${controlSquare.md} min-h-[var(--control-md)]`}
                  icon={<X weight="bold" aria-hidden="true" />}
                />
              </span>
            ) : null}
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              清除筛选
            </Button>
          </div>
        ) : null}

        {/* Batch bar only exists once something is selected. Select-all stays reachable
            before that as a bare checkbox, so the bar is not the only way in. */}
        {isAnySelected ? (
          <div className="motion-reveal flex flex-wrap items-center justify-between gap-3 rounded-panel bg-tonal px-4 py-3">
            {selectAllCheckbox}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">已选 {selectedAssetIds.length} 个 · 不包含未加载作品</span>
              <Button variant="ghost" disabled={batchDeleting} onClick={clearSelectedAssets}>取消选择</Button>
              <Button variant="danger-ghost" loading={batchDeleting} icon={<Trash2 weight="bold" aria-hidden="true" />} onClick={() => setBatchDeleteOpen(true)}>删除选中</Button>
            </div>
          </div>
        ) : visibleAssets.length > 0 ? (
          <div className="flex">{selectAllCheckbox}</div>
        ) : null}

        {deleteFeedback ? (
          <Alert tone="danger" title="删除未全部完成" action={isAnySelected ? <Button variant="secondary" onClick={() => setBatchDeleteOpen(true)}>重试失败项</Button> : undefined}>
            {deleteFeedback}
          </Alert>
        ) : null}

        {/* A stale background refresh keeps the tiles on screen and says so here
            instead of replacing a working grid with a spinner. */}
        {isError && data ? (
          <Alert
            tone="danger"
            title="图库刷新失败"
            action={
              <Button variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>
                刷新重试
              </Button>
            }
          >
            当前显示的是已加载内容：{error instanceof Error ? error.message : '网络或服务端错误'}。请稍后重试刷新。
          </Alert>
        ) : null}
      </div>

      <Dialog
        open={batchDeleteOpen}
        onClose={() => { if (!batchDeleting) setBatchDeleteOpen(false) }}
        size="narrow"
        title={`确定要删除选中的 ${selectedAssetIds.length} 个作品吗？`}
        footer={
          <>
            <Button variant="secondary" disabled={batchDeleting} onClick={() => setBatchDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={batchDeleting}
              onClick={() => void confirmBatchDelete()}
            >
              删除作品
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          这 {selectedAssetIds.length} 个作品将从作品库中永久删除，对应的生成记录不受影响。此操作无法撤销。
        </p>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTargetId(null)}
        size="narrow"
        title="确定要删除这个作品吗？"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTargetId(null)}>
              取消
            </Button>
            <Button variant="danger" loading={deleteMutation.isPending} onClick={confirmSingleDelete}>
              删除作品
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          “{deleteTarget?.prompt?.trim() || '（无提示词）'}” 将从作品库中永久删除。此操作无法撤销。
        </p>
      </Dialog>

      {/* Full-size preview: portal, focus trap and the close animation are all
          in `AssetLightbox` / `useDialog`, so no window keydown lives here. */}
      <AssetLightbox
        assets={visibleAssets}
        activeAssetId={previewAssetId}
        onClose={closePreview}
        onSelect={openPreview}
      />
    </ContentFrame>
  )
}
