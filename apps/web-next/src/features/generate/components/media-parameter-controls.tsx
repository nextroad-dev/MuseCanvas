'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Switch } from '@/shared/components/ui/switch'
import {
  descriptorLabel,
  descriptorOptions,
  effectiveValue,
  isAdvancedParameter,
  marshalDescriptorValue,
  mediaControlDescriptors,
  resolveDescriptor,
  wireType,
  canonicalNameOf,
} from '@/shared/lib/media-parameters'
import type { ParameterCarrier, ParameterState, ParameterValue } from '@/shared/lib/media-parameters'
import { SizePickerControl } from './size-picker-control'
import type { DescriptorOption } from '@/shared/lib/media-parameters'
import type { ParameterDescriptor } from '@musecanvas/contracts'

export interface MediaParameterControlsProps {
  model: ParameterCarrier | null | undefined
  /**
   * Canonical parameter name -> picked value. An absent key means "show this
   * descriptor's own default", which is what keeps a model switch cheap: nothing
   * has to be reset, and nothing stale is remembered.
   */
  values: ParameterState
  onChange: (name: string, value: ParameterValue) => void
  /**
   * Unit appended to the count control. Presentation only, supplied by the
   * console because it knows whether it is showing images or clips.
   */
  countUnit?: string
}

/** Past this many options a pill row stops fitting the control bar. */
const SEGMENTED_MAX_OPTIONS = 6

const SELECT_CLASS =
  'rounded-[var(--radius-control)] border border-border bg-surface-subtle px-2.5 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-surface-subtle-strong'
const PILL_GROUP_CLASS = 'flex rounded-[var(--radius-control)] border border-border bg-surface-subtle p-0.5'
const PILL_CLASS =
  'flex items-center gap-1 rounded-[calc(var(--radius-control)-2px)] px-2 py-1 text-xs font-medium transition-colors'
const PILL_SELECTED_CLASS = 'bg-surface text-foreground shadow-sm'
const PILL_IDLE_CLASS = 'text-muted-foreground hover:text-foreground'
const INPUT_CLASS =
  'w-20 rounded-[var(--radius-control)] border border-border bg-surface px-2 py-1 text-xs text-foreground outline-none'

/** Native selects and inputs only ever yield strings, so compare in string space. */
function isSameValue(optionValue: ParameterValue, value: ParameterValue | undefined) {
  return value !== undefined && String(optionValue) === String(value)
}

/**
 * Stable DOM id for a control's visible label.
 *
 * Keyed on the declared name rather than the canonical alias: two parameters can
 * share a canonical name across models, but within one model the declared name is
 * unique, and a duplicate id silently breaks every `aria-labelledby` after it.
 */
function labelId(descriptor: ParameterDescriptor): string {
  return `gen-param-${descriptor.name}`
}

export function MediaParameterControls({ model, values, onChange, countUnit }: MediaParameterControlsProps) {
  // Visibility depends on the current values, because a `dependsOn` parameter is
  // only offered while its controlling parameter holds a matching value.
  const controls = mediaControlDescriptors(model, values)
  const advancedControls = controls.filter((descriptor) => isAdvancedParameter(descriptor))
  const primaryControls = controls.filter((descriptor) => !isAdvancedParameter(descriptor))
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const countDescriptor = resolveDescriptor(model, 'count')
  const countOptions = descriptorOptions(countDescriptor)

  if (primaryControls.length === 0 && countOptions.length === 0) return null

  function pick(descriptor: ParameterDescriptor, raw: ParameterValue) {
    onChange(canonicalNameOf(descriptor), marshalDescriptorValue(descriptor, raw))
  }

  function renderControl(descriptor: ParameterDescriptor) {
    if (descriptor.type === 'image-size') {
      return (
        <SizePickerControl
          descriptor={descriptor}
          label={descriptorLabel(descriptor, model)}
          labelId={labelId(descriptor)}
          value={typeof effectiveValue(model, descriptor, values) === 'string'
            ? String(effectiveValue(model, descriptor, values))
            : undefined}
          onChange={(next) => pick(descriptor, next)}
        />
      )
    }

    if (descriptor.type === 'boolean') {
      const on = effectiveValue(model, descriptor, values) !== false
      return (
        <Switch
          checked={on}
          onCheckedChange={(next) => pick(descriptor, next)}
          aria-labelledby={labelId(descriptor)}
        />
      )
    }

    // A range control is offered whenever the descriptor asks for one, for both
    // integer and float parameters: `output_compression` is an integer that is
    // meaningless as an enumerated pill list.
    if (descriptor.ui?.control === 'slider' && (descriptor.type === 'integer' || descriptor.type === 'number')) {
      return (
        <SliderControl
          descriptor={descriptor}
          value={effectiveValue(model, descriptor, values)}
          onChange={(next) => pick(descriptor, next)}
        />
      )
    }

    const options = descriptorOptions(descriptor)
    if (options.length === 0) return null

    const unit = descriptor.ui?.unit ?? (canonicalNameOf(descriptor) === 'durationSeconds' ? ' 秒' : '')

    if (descriptor.ui?.control === 'select' || options.length > SEGMENTED_MAX_OPTIONS) {
      const value = effectiveValue(model, descriptor, values)
      return (
        <select
          aria-labelledby={labelId(descriptor)}
          value={value === undefined ? '' : String(value)}
          onChange={(event) => pick(descriptor, event.target.value)}
          className={SELECT_CLASS}
        >
          {options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {`${option.label}${unit}${option.isDefault ? ' · 默认' : ''}`}
            </option>
          ))}
        </select>
      )
    }

    return (
      <ValuePills
        descriptor={descriptor}
        model={model}
        options={options}
        values={values}
        onChange={onChange}
        unit={unit}
      />
    )
  }

  return (
    <>
      {primaryControls.map((descriptor) => (
        <ParameterField
          key={descriptor.name}
          descriptor={descriptor}
          model={model}
        >
          {renderControl(descriptor)}
        </ParameterField>
      ))}

      {countDescriptor && countOptions.length > 0 && (
        <ParameterField descriptor={countDescriptor} model={model}>
          <ValuePills
            descriptor={countDescriptor}
            model={model}
            options={countOptions}
            values={values}
            onChange={onChange}
            unit={countUnit ?? countDescriptor.ui?.unit ?? ''}
          />
        </ParameterField>
      )}

      {advancedControls.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex items-center gap-1 px-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              aria-hidden="true"
              className={`h-3 w-3 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
            />
            更多参数
          </button>
          {advancedOpen && advancedControls.map((descriptor) => (
            <ParameterField
              key={descriptor.name}
              descriptor={descriptor}
              model={model}
              as="div"
            >
              {renderControl(descriptor)}
            </ParameterField>
          ))}
        </div>
      )}
    </>
  )
}

function ParameterField({
  descriptor,
  model,
  as = 'div',
  children,
}: {
  descriptor: ParameterDescriptor
  model: ParameterCarrier | null | undefined
  as?: 'div' | 'span'
  children: React.ReactNode
}) {
  const Tag = as
  const label = descriptorLabel(descriptor, model)
  return (
    <Tag className="flex flex-col gap-1">
      <span id={labelId(descriptor)} className="px-0.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {descriptor.description && (
        <span className="px-0.5 text-[10px] leading-relaxed text-muted-foreground">
          {descriptor.description}
        </span>
      )}
    </Tag>
  )
}

function SliderControl({
  descriptor,
  value,
  onChange,
}: {
  descriptor: ParameterDescriptor
  value: ParameterValue | undefined
  onChange: (value: ParameterValue) => void
}) {
  const bounds = descriptor.type === 'integer' || descriptor.type === 'number'
    ? { min: descriptor.min ?? 0, max: descriptor.max ?? 100, step: descriptor.step ?? 1 }
    : { min: 0, max: 100, step: 1 }
  const numeric = Number(value ?? bounds.min)
  return (
    <label className="flex items-center gap-2">
      <input
        type="range"
        aria-label={descriptor.label ?? descriptor.name}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={Number.isFinite(numeric) ? numeric : bounds.min}
        onChange={(event) => onChange(marshalDescriptorValue(descriptor, event.target.value))}
        className="h-1.5 w-28 accent-[var(--color-accent-strong)]"
      />
      <input
        type="number"
        aria-label={`${descriptor.label ?? descriptor.name} 数值`}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={Number.isFinite(numeric) ? numeric : bounds.min}
        onChange={(event) => onChange(marshalDescriptorValue(descriptor, event.target.value))}
        className={INPUT_CLASS}
      />
    </label>
  )
}

function ValuePills({
  descriptor,
  model,
  options,
  values,
  onChange,
  unit = '',
}: {
  descriptor: ParameterDescriptor
  model: ParameterCarrier | null | undefined
  options: DescriptorOption[]
  values: ParameterState
  onChange: MediaParameterControlsProps['onChange']
  unit?: string
}) {
  const value = effectiveValue(model, descriptor, values)
  return (
    <div role="group" aria-labelledby={labelId(descriptor)} className={PILL_GROUP_CLASS}>
      {options.map((option) => {
        const selected = isSameValue(option.value, value)
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
            title={option.description}
            onClick={() => onChange(canonicalNameOf(descriptor), marshalDescriptorValue(descriptor, option.value))}
            className={`${PILL_CLASS} ${selected ? PILL_SELECTED_CLASS : PILL_IDLE_CLASS}`}
          >
            <span>{`${option.label}${unit}`}</span>
            {option.isDefault && (
              <span className="text-[10px] font-normal text-muted-foreground">默认</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Exported so the console can mirror the same key choice when it writes state. */
export { wireType }
