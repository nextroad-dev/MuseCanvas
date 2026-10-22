'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CaretDownIcon as ChevronDown, CheckIcon as Check } from '@phosphor-icons/react'
import { SegmentedControl } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { exitDurationMs } from '@/shared/lib/motion'
import { modelCapabilityNote, resolveActiveModel } from '@/shared/lib/model-capabilities'
import type { DefaultAwareModel } from '@/shared/lib/model-capabilities'
import type { GenerateModeTab } from '@/shared/types'

export interface ModelPickerProps {
  imageModels: DefaultAwareModel[]
  videoModels: DefaultAwareModel[]
  /** The kind the composer currently submits as. */
  activeKind: GenerateModeTab
  /** Remembered pick per kind; empty means "fall back to the admin default". */
  selectedModelIdByKind: Record<GenerateModeTab, string>
  /**
   * A pick always carries its kind: choosing from the 视频 tab switches the
   * composer to video, so the request modelId can never come from the wrong
   * catalogue.
   */
  onSelect: (kind: GenerateModeTab, id: string) => void
  disabled?: boolean
}

const KIND_LABEL: Record<GenerateModeTab, string> = { image: '图像', video: '视频' }

/**
 * Bespoke non-modal model picker.
 *
 * A `button[aria-haspopup="dialog"]` trigger plus an inline
 * `div[role="dialog"]` panel with a `SegmentedControl` kind switch and a
 * `role="listbox"` catalogue. Deliberately *not* `DropdownMenu` (its panel is
 * `role="menu"` and cannot carry listbox semantics) and *not* `useDialog`
 * (that hook is always modal with a scrim and focus trap — this panel floats
 * above the composer while the conversation stays interactive).
 *
 * Positioning and motion copy the dropdown rung: a `relative` wrapper, an
 * `absolute` `rounded-popover` + `shadow-dropdown` panel, `motion-menu` on
 * enter and `motion-fade-out` on exit (kept mounted for the exit token). The
 * panel opens upward because the composer sits at the bottom of the
 * conversation column.
 */
export function ModelPicker({
  imageModels,
  videoModels,
  activeKind,
  selectedModelIdByKind,
  onSelect,
  disabled = false,
}: ModelPickerProps) {
  const uid = useId()
  const panelId = `${uid}-model-picker`
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef(new Map<string, HTMLLIElement | null>())
  const [open, setOpen] = useState(false)
  // `mounted` trails `open` by the exit token, so the panel fades out instead of
  // vanishing; `closing` drives the exit class and the inert state while it leaves.
  const [mounted, setMounted] = useState(false)
  const [closing, setClosing] = useState(false)
  // The viewed tab starts on the composer's kind and roams freely until a pick
  // (or close) — it is a view, never a submit.
  const [viewTab, setViewTab] = useState<GenerateModeTab>(activeKind)

  const catalogues: Record<GenerateModeTab, DefaultAwareModel[]> = { image: imageModels, video: videoModels }
  const activeModel = resolveActiveModel(catalogues[activeKind], selectedModelIdByKind[activeKind])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (open) {
      setClosing(false)
      setMounted(true)
      return
    }
    if (mounted) setClosing(true)
  }, [open, mounted])

  // Teardown after the exit token's duration (`--motion-exit`), read at runtime.
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => {
      setClosing(false)
      setMounted(false)
    }, exitDurationMs())
    return () => window.clearTimeout(timer)
  }, [closing])

  // Opening always re-anchors the viewed tab on the composer's kind, so a
  // reopened panel never shows the stale tab of a previous visit.
  function setOpenAnchored(next: boolean) {
    if (next) setViewTab(activeKind)
    setOpen(next)
  }

  // Open → land on the selected option of the viewed tab (or the first), so
  // the keyboard never has to discover that a panel appeared.
  useEffect(() => {
    if (!open) return
    const list = catalogues[viewTab]
    const selectedId = selectedModelIdByKind[viewTab]
    const target = list.some((model) => model.id === selectedId)
      ? selectedId
      : list[0]?.id
    if (target) optionRefs.current.get(target)?.focus()
    // Anchored per open transition only: roaming the tabs must not yank focus.
  }, [open])

  // Click / tap outside. A document listener, not a viewport catcher: the
  // catcher would need its own stacking level under the ladder.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (wrapperRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function close(restoreFocus: boolean) {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  function pick(kind: GenerateModeTab, id: string) {
    onSelect(kind, id)
    close(true)
  }

  function focusOption(list: DefaultAwareModel[], index: number) {
    if (list.length === 0) return
    const target = list[(index + list.length) % list.length]
    optionRefs.current.get(target.id)?.focus()
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLLIElement>, list: DefaultAwareModel[], index: number) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusOption(list, index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusOption(list, index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusOption(list, 0)
        break
      case 'End':
        event.preventDefault()
        focusOption(list, list.length - 1)
        break
      case 'Enter':
      case ' ': {
        const model = list[index]
        if (!model) return
        event.preventDefault()
        pick(viewTab, model.id)
        break
      }
      case 'Escape':
        event.preventDefault()
        close(true)
        break
      case 'Tab':
        // Tab leaves the panel; it never roams it. Focus moves on naturally.
        setOpen(false)
        break
      default:
        break
    }
  }

  const viewModels = catalogues[viewTab]
  const emptyLabel = viewTab === 'video' ? '尚未配置视频模型' : '尚未配置图像模型'
  // The effective pick of the viewed tab: the stored id when still offered,
  // else the admin default. Only the composer's own kind can be "the" current
  // pick; the other tab previews what a switch would submit with.

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpenAnchored(true))}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
            event.preventDefault()
            setOpenAnchored(true)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            close(true)
          }
        }}
        className="inline-flex min-h-[var(--control-sm)] max-w-full items-center gap-2 rounded-control bg-tonal px-2 py-1 text-sm text-foreground transition-colors hover:bg-tonal-hover active:bg-tonal-active disabled:cursor-not-allowed disabled:opacity-[var(--opacity-disabled)]"
      >
        <span className="shrink-0 rounded-control bg-surface px-1.5 py-px text-caption font-medium">{KIND_LABEL[activeKind]}</span>
        <span className="min-w-0 truncate">{activeModel?.displayName ?? '选择模型'}</span>
        <ChevronDown weight="bold" aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      {open || mounted ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="选择模型"
          inert={closing}
          className={cn(
            'absolute bottom-full left-0 z-dropdown mb-2 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-popover border border-border bg-surface p-2 shadow-dropdown',
            closing ? 'pointer-events-none motion-fade-out' : 'motion-menu',
          )}
        >
          {/* Local override only: the shared control keeps its surface thumb and 12px labels. */}
          <SegmentedControl
            label="输出类型"
            size="sm"
            className="[&>button]:text-[13px]"
            value={viewTab}
            onChange={(value) => setViewTab(value as GenerateModeTab)}
            items={[
              { value: 'image', label: '图像' },
              { value: 'video', label: '视频' },
            ]}
          />
          {viewModels.length === 0 ? (
            <p role="status" className="px-2 py-4 text-center text-sm text-muted-foreground">{emptyLabel}</p>
          ) : (
            <OptionsList
              models={viewModels}
              viewTab={viewTab}
              activeKind={activeKind}
              selectedId={resolveActiveModel(viewModels, selectedModelIdByKind[viewTab])?.id}
              optionRefs={optionRefs}
              onPick={(id) => pick(viewTab, id)}
              onOptionKeyDown={onOptionKeyDown}
            />
          )}
          <p className="border-t border-border px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">
            新对话默认使用管理员设置的模型，切换后本对话保持你的选择。
          </p>
        </div>
      ) : null}
    </div>
  )
}

function OptionsList({
  models,
  viewTab,
  activeKind,
  selectedId,
  optionRefs,
  onPick,
  onOptionKeyDown,
}: {
  models: DefaultAwareModel[]
  viewTab: GenerateModeTab
  activeKind: GenerateModeTab
  selectedId: string | undefined
  optionRefs: React.MutableRefObject<Map<string, HTMLLIElement | null>>
  onPick: (id: string) => void
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLLIElement>, list: DefaultAwareModel[], index: number) => void
}) {
  return (
    <ul role="listbox" aria-label="模型" className="m-0 flex max-h-60 list-none flex-col gap-0.5 overflow-y-auto p-0">
      {models.map((model, index) => {
        const selected = viewTab === activeKind && model.id === selectedId
        const isDefault = model.isDefault === true
        const note = model.deprecated
          ? `${modelCapabilityNote(model)}（已弃用）`
          : modelCapabilityNote(model)
        return (
          <li
            key={model.id}
            ref={(node) => {
              optionRefs.current.set(model.id, node)
            }}
            role="option"
            aria-selected={selected}
            tabIndex={index === 0 ? 0 : -1}
            onClick={() => onPick(model.id)}
            onKeyDown={(event) => onOptionKeyDown(event, models, index)}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-control p-2.5 outline-none transition-colors',
              selected ? 'bg-tonal-selected' : 'hover:bg-tonal-hover active:bg-tonal-active',
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <span className="min-w-0 truncate">{model.displayName}</span>
                {isDefault ? (
                  <span className="shrink-0 rounded-pill bg-tonal px-1.5 text-caption font-medium text-muted-foreground">默认</span>
                ) : null}
              </span>
              {note ? <span className="truncate text-xs text-muted-foreground">{note}</span> : null}
            </span>
            {selected ? <Check weight="bold" aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground" /> : null}
          </li>
        )
      })}
    </ul>
  )
}
