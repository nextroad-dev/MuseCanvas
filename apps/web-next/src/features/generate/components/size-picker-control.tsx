'use client'

import { useId, useState } from 'react'
import {
  asImageSizeDescriptor,
  customSizeViolations,
  describeConstraints,
  imageSizeOptions,
} from '@/shared/lib/media-parameters'
import type { DescriptorOption } from '@/shared/lib/media-parameters'
import type { ParameterDescriptor } from '@musecanvas/contracts'

export interface SizePickerControlProps {
  descriptor: ParameterDescriptor
  /** Current wire value, e.g. `1024x1024` or `auto`. */
  value: string | undefined
  onChange: (value: string) => void
  /** Visible label, already resolved from the descriptor. */
  label: string
  labelId: string
}

const CUSTOM_VALUE = '__custom__'

/**
 * Size selection driven entirely by an `image-size` descriptor.
 *
 * Presets are labelled from their own geometry (`3:2 · 1536 × 1024`) while the
 * value that leaves this component is still `1536x1024`, because the friendly
 * text is presentation and the wire form is the contract.
 *
 * The custom inputs are validated through the same constraint routine the API
 * and the plugin run, so "the button is enabled" and "the server will accept
 * this" are the same statement. Every hint below — grid step, pixel band, edge
 * caps, ratio limit — is derived from the descriptor, never written here, which
 * is what lets a future provider ship a different band without a frontend
 * change.
 */
export function SizePickerControl({ descriptor, value, onChange, label, labelId }: SizePickerControlProps) {
  const size = asImageSizeDescriptor(descriptor)
  const errorId = `${useId()}-size-errors`
  const options = size ? imageSizeOptions(size) : []
  const known = options.some((option) => option.value === value)
  // A value outside the preset list can only be a custom size, so the custom
  // branch opens itself on reload/rehydrate instead of silently snapping back.
  const [customOverride, setCustomOverride] = useState(false)
  const customActive = Boolean(size?.allowCustom) && (customOverride || (value !== undefined && !known))

  if (!size) return null
  // Narrowed copy: the `select`/`setEdge` closures below are created after this
  // guard, but TypeScript does not carry a `const` narrowing from a component
  // body into a nested function declaration.
  const contract = size

  const selected = customActive ? CUSTOM_VALUE : (value ?? contract.defaultValue ?? '')
  // Always the same shape, whether or not custom mode is open.
  const draft = parseDraft(customActive ? value : undefined)
  const violations = customActive
    ? customSizeViolations(contract.constraints, draft.widthAsNumber, draft.heightAsNumber, contract.name)
    : []
  const hints = customActive ? describeConstraints(contract.constraints) : []

  function select(next: string) {
    if (next === CUSTOM_VALUE) {
      setCustomOverride(true)
      // Seed the inputs from the first concrete preset so the draft the user
      // starts from is a valid size rather than an error to clear first.
      const seed = contract.presets.find((preset) => preset.width && preset.height)
      onChange(seed ? `${seed.width}x${seed.height}` : String(contract.defaultValue ?? ''))
      return
    }
    setCustomOverride(false)
    onChange(next)
  }

  function setEdge(edge: 'width' | 'height', raw: string) {
    // The untouched edge keeps its own current value; taking `raw` for both
    // would silently copy the number being edited onto the other axis.
    const width = edge === 'width' ? raw : draft.widthRaw
    const height = edge === 'height' ? raw : draft.heightRaw
    setCustomOverride(true)
    onChange(`${width || '0'}x${height || '0'}`)
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-labelledby={labelId}
        value={selected}
        onChange={(event) => select(event.target.value)}
        className={SELECT_CLASS}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {optionLabel(option)}
          </option>
        ))}
        {size.allowCustom === true && (
          <option value={CUSTOM_VALUE}>自定义尺寸</option>
        )}
      </select>

      {customActive && (
        <div className="flex flex-col gap-1 rounded-[var(--radius-control)] border border-border bg-surface-subtle p-2">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              宽
              <input
                type="number"
                inputMode="numeric"
                aria-label={`${label} 宽度`}
                aria-invalid={violations.length > 0}
                aria-describedby={violations.length > 0 ? errorId : undefined}
                value={draft.widthRaw}
                onChange={(event) => setEdge('width', event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <span aria-hidden="true" className="text-xs text-muted-foreground">×</span>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              高
              <input
                type="number"
                inputMode="numeric"
                aria-label={`${label} 高度`}
                aria-invalid={violations.length > 0}
                value={draft.heightRaw}
                onChange={(event) => setEdge('height', event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          </div>

          {hints.length > 0 && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{hints.join(' · ')}</p>
          )}

          {/* Announced, not merely coloured: a blocked submit button with no
              explanation reads as a broken control. */}
          <div id={errorId} aria-live="polite" role="status">
            {violations.map((message) => (
              <p key={message} className="text-[11px] font-medium text-danger">
                {message}
              </p>
            ))}
          </div>
        </div>
      )}

      {!customActive && options.find((option) => option.value === selected)?.description && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {options.find((option) => option.value === selected)?.description}
        </p>
      )}
    </div>
  )
}

function optionLabel(option: DescriptorOption): string {
  const experimental = option.experimental ? '（实验性）' : ''
  return `${option.label}${experimental}${option.isDefault ? ' · 默认' : ''}`
}

/** Split a `WxH` wire value back into editable text, keeping partial input. */
function parseDraft(value: string | undefined) {
  const match = /^(\d*)x(\d*)$/.exec(value ?? '')
  const widthRaw = match?.[1] ?? ''
  const heightRaw = match?.[2] ?? ''
  return {
    widthRaw,
    heightRaw,
    widthAsNumber: Number(widthRaw),
    heightAsNumber: Number(heightRaw),
  }
}

const SELECT_CLASS =
  'rounded-[var(--radius-control)] border border-border bg-surface-subtle px-2.5 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-surface-subtle-strong'
const INPUT_CLASS =
  'w-20 rounded-[var(--radius-control)] border border-border bg-surface px-2 py-1 text-xs text-foreground outline-none'
