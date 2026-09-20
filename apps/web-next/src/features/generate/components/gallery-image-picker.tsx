'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, ImageOff, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { MediaFrame } from '@/shared/components/media-frame'
import { useDialog } from '@/shared/hooks/useDialog'
import { libraryPageItems, useLibraryInfiniteQuery } from '@/shared/hooks/useLibrary'
import { api } from '@/shared/services/api'
import { isReferenceEligibleAsset } from '@/shared/lib/reference-upload'
import { assetPlaybackUrl, assetPreviewUrl } from '@/shared/types'
import type { Asset } from '@/shared/types'

/** Same page size the gallery grid uses, so both surfaces walk the library alike. */
const PAGE_SIZE = 30
const SEARCH_DEBOUNCE_MS = 300

/** Assets whose preview already failed and was re-signed once. Module scope, so
 *  closing and reopening the picker cannot restart an error→sign→error loop. */
const alreadyResigned = new Set<string>()

export interface GalleryImagePickerProps {
  open: boolean
  onClose: () => void
  /** Called only from 「使用此图片」, so a click never closes the dialog by surprise. */
  onSelect: (asset: Asset) => void
  /** Images already staged: the same asset twice would occupy two slots with one
   *  picture, and the server refuses it anyway. */
  excludedAssetIds?: readonly string[]
  /** Explains in the header what the pick is for, in the page's own words. */
  noun?: string
}

/**
 * Pick one existing image from the user's own gallery instead of uploading a file.
 *
 * Reads the same `GET /api/library` endpoint, cursor and cache entry as the gallery
 * page — there is no second image source here. Selecting a tile only marks it; the
 * pick becomes an input when the user confirms, and the caller receives the `Asset`
 * itself so nothing is downloaded or re-uploaded afterwards.
 */
export function GalleryImagePicker({
  open,
  onClose,
  onSelect,
  excludedAssetIds = [],
  noun = '参考图',
}: GalleryImagePickerProps) {
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [resignedUrls, setResignedUrls] = useState<Record<string, string>>({})

  // Debounced so typing a keyword is not one request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchDraft])

  const { mounted, phase, labelId, closeButtonRef, portalTarget, rootProps, dialogProps } =
    useDialog({ open, onClose })

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useLibraryInfiniteQuery(
      { limit: PAGE_SIZE, eligible: true, ...(search ? { q: search } : {}) },
      { enabled: open },
    )

  const assets = useMemo(() => libraryPageItems(data), [data])
  const excluded = useMemo(() => new Set(excludedAssetIds), [excludedAssetIds])
  // Resolved from the fetched rows on every render rather than stored, so a refetch or
  // a library delete can only close the confirmation, never leave a stale tile armed.
  const selected = assets.find((asset) => asset.id === selectedId) ?? null

  const total = data?.pages[0]?.total ?? assets.length

  // A new search or a reopen starts from no selection: confirming an image that is no
  // longer on screen would be worse than pressing the button again.
  useEffect(() => {
    if (!open) setSelectedId(null)
  }, [open])
  useEffect(() => setSelectedId(null), [search])

  /** Signed URLs expire; re-ask for this one asset, once, and let the new `src` reset
   *  the frame's own load cycle. */
  const resignPreview = useCallback(async (asset: Asset) => {
    if (alreadyResigned.has(asset.id)) return
    alreadyResigned.add(asset.id)
    const res = await api.getAssetDownloadUrl(asset.id)
    const url = res.success ? res.data?.url : undefined
    if (url) {
      setResignedUrls((current) => ({ ...current, [asset.id]: url }))
      return
    }
    alreadyResigned.delete(asset.id)
  }, [])

  const confirm = useCallback(() => {
    if (!selected) return
    onSelect(selected)
  }, [onSelect, selected])

  if (!mounted || !portalTarget) return null

  const closing = phase === 'close'

  return createPortal(
    <div
      {...rootProps}
      className={`fixed inset-0 z-[var(--z-index-overlay)] flex items-end justify-center p-4 sm:items-center ${
        closing ? 'pointer-events-none' : ''
      }`}
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 bg-overlay/40 ${closing ? 'motion-fade-out' : 'motion-fade-in'}`}
      />

      <p className="sr-only" role="status" aria-live="polite">
        {isLoading
          ? '正在读取图库'
          : isError
            ? '图库读取失败'
            : `图库共 ${total} 张，已加载 ${assets.length} 张${selected ? '，已选择 1 张' : ''}`}
      </p>

      <div
        {...dialogProps}
        className={`relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 rounded-[var(--radius-panel)] border border-border bg-surface p-5 shadow-lg ${
          closing ? 'motion-dialog-out' : 'motion-dialog-in'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={labelId} className="text-[var(--text-subtitle)] leading-[1.4] text-foreground">
              从图库选择
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              直接使用已有作品作为{noun}，不会重新上传，也不会生成重复文件。
            </p>
          </div>
          <button
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="关闭图库选择器"
            className="flex min-h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <label className="relative flex items-center">
          <span className="sr-only">按提示词搜索图库图片</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="搜索图片提示词…"
            maxLength={100}
            className="min-h-8 w-full rounded-[var(--radius-control)] border border-border-control bg-surface pl-9 pr-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </label>

        <div className="-mx-1 min-h-[16rem] flex-1 overflow-y-auto px-1 py-1">
          {isLoading ? (
            <div className="flex h-full items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
              正在读取图库…
            </div>
          ) : isError ? (
            <div
              role="status"
              className="flex items-start justify-between gap-3 rounded-[var(--radius-popover)] border border-danger-border bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              <div className="flex items-start gap-2">
                <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error?.message || '无法读取图库，请检查网络后重试。'}</span>
              </div>
              <button
                type="button"
                onClick={() => void refetch()}
                className="flex min-h-8 shrink-0 items-center gap-1 rounded-[var(--radius-control)] border border-danger px-2.5 text-xs font-medium transition-colors duration-[var(--motion-fast)] hover:bg-danger hover:text-foreground-inverse"
              >
                <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                重试
              </button>
            </div>
          ) : assets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-border bg-surface-subtle px-6 py-12 text-center">
              <ImageOff aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">
                {search ? '没有匹配的图库图片' : '图库还没有可用的图片'}
              </p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {search
                  ? '换个关键词试试，或清空搜索框浏览全部作品。'
                  : '图库里的图片作品（PNG 或 JPEG）才能作为输入参考；生成几张图片后再回来选择即可。'}
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {assets.map((asset) => {
                const isSelected = asset.id === selectedId
                // Defence in depth, not a permission check: the server already scoped
                // this list to the signed-in user and to PNG/JPEG images. An
                // ineligible row can only come from a cache entry taken elsewhere.
                const unsupported = !isReferenceEligibleAsset(asset)
                const alreadyAdded = excluded.has(asset.id)
                const disabled = unsupported || alreadyAdded
                const reason = unsupported ? '格式不支持作为参考图' : alreadyAdded ? '已在列表中' : ''
                const refreshed = resignedUrls[asset.id]
                return (
                  <li key={asset.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-pressed={isSelected}
                      aria-label={
                        reason
                          ? `${asset.prompt || '图库图片'}，${reason}`
                          : `选择图库图片：${asset.prompt || '未命名'}`
                      }
                      onClick={() => setSelectedId(isSelected ? null : asset.id)}
                      className={`relative block w-full overflow-hidden rounded-[var(--radius-control)] border-2 transition-colors duration-[var(--motion-fast)] ${
                        isSelected
                          ? 'border-accent'
                          : disabled
                            ? 'cursor-not-allowed border-border opacity-50'
                            : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <MediaFrame
                        src={refreshed ?? assetPlaybackUrl(asset)}
                        previewSrc={refreshed ? undefined : assetPreviewUrl(asset)}
                        kind="image"
                        alt={asset.prompt || '图库图片'}
                        layout="tile"
                        width={asset.width}
                        height={asset.height}
                        onMediaError={() => void resignPreview(asset)}
                      />
                      <span
                        aria-hidden="true"
                        className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                          isSelected
                            ? 'border-accent bg-accent text-foreground-inverse'
                            : 'border-foreground-inverse/70 bg-overlay/50'
                        }`}
                      >
                        {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                      </span>
                      {reason ? (
                        <span className="absolute inset-x-0 bottom-0 bg-overlay/80 px-1.5 py-1 text-center text-[11px] leading-[1.4] text-foreground-inverse">
                          {reason}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {hasNextPage && !isLoading && !isError ? (
            <div className="flex items-center justify-center pt-3">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="flex min-h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle disabled:opacity-60"
              >
                {isFetchingNextPage ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {isFetchingNextPage ? '正在加载…' : '加载更多'}
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            已加载 {assets.length} / {total} 张
            {search ? ` · 关键词「${search}」` : ''}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex min-h-8 items-center rounded-[var(--radius-control)] bg-surface-subtle px-3 text-sm font-medium text-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle-strong"
            >
              取消
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!selected}
              className="flex min-h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-3 text-sm font-medium text-canvas transition-colors duration-[var(--motion-fast)] hover:bg-primary-hover disabled:opacity-50"
            >
              <Check aria-hidden="true" className="h-4 w-4" />
              使用此图片
            </button>
          </div>
        </div>
      </div>
    </div>,
    portalTarget,
  )
}
