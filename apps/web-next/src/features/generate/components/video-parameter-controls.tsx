'use client'

import { Volume2, VolumeX } from 'lucide-react'
import {
  canonicalNameOf,
  descriptorDefault,
  descriptorLabel,
  descriptorOptions,
  marshalDescriptorValue,
  resolveDescriptor,
  videoControlDescriptors,
} from '@/shared/lib/generation-params'
import type { DescriptorOption } from '@/shared/lib/generation-params'
import type { ModelConfig, ParameterDescriptor } from '@/shared/types'

export interface VideoParameterControlsProps {
  model: Pick<ModelConfig, 'parameters' | 'defaults' | 'maxCount'> | null | undefined
  /** Canonical parameter name -> picked value. `{}` means "every control shows
   *  its descriptor default", which is what keeps model switches cheap. */
  values: Record<string, string | number | boolean>
  onChange: (name: string, value: string | number | boolean) => void
}

type ModelParamView = VideoParameterControlsProps['model']

/** Past this many options a pill row stops fitting the control bar, so the
 *  control degrades to a native select (Seedance durations are 1..30). */
const SEGMENTED_MAX_OPTIONS = 6

/** Copied from the console's existing selects so both tabs read as one bar. */
const SELECT_CLASS =
  'rounded-[var(--radius-control)] border border-border bg-surface-subtle px-2.5 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-surface-subtle-strong'

/** Copied from the console's existing image-count pill group. */
const PILL_GROUP_CLASS =
  'flex rounded-[var(--radius-control)] border border-border bg-surface-subtle p-0.5'
const PILL_CLASS =
  'flex items-center gap-1 rounded-[calc(var(--radius-control)-2px)] px-2 py-1 text-xs font-medium transition-colors'
const PILL_SELECTED_CLASS = 'bg-surface text-foreground shadow-sm'
const PILL_IDLE_CLASS = 'text-muted-foreground hover:text-foreground'

/** Option values keep their descriptor type in state, but a native select only
 *  ever yields strings, so selection is compared in string space and written
 *  back through `marshalDescriptorValue`. */
function isSameValue(optionValue: string | number | boolean, value: string | number | boolean) {
  return String(optionValue) === String(value)
}

function effectiveValue(
  model: ModelParamView,
  descriptor: ParameterDescriptor,
  values: Record<string, string | number | boolean>,
): string | number | boolean | undefined {
  const canonical = canonicalNameOf(descriptor)
  const picked = values[canonical] ?? values[descriptor.name]
  if (picked !== undefined) return marshalDescriptorValue(descriptor, picked)
  const fallback = descriptorDefault(model, descriptor.name, undefined)
  if (fallback === undefined) return undefined
  return marshalDescriptorValue(descriptor, fallback as string | number | boolean)
}

function optionLabel(descriptor: ParameterDescriptor, option: DescriptorOption): string {
  const unit = canonicalNameOf(descriptor) === 'durationSeconds' ? ' 秒' : ''
  return `${option.label}${unit}`
}

/** Stable DOM id for a control's visible label, reused as the accessible name. */
function labelId(descriptor: ParameterDescriptor): string {
  return `gen-param-${canonicalNameOf(descriptor)}`
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
  model: ModelParamView
  options: DescriptorOption[]
  values: Record<string, string | number | boolean>
  onChange: VideoParameterControlsProps['onChange']
  unit?: string
}) {
  const value = effectiveValue(model, descriptor, values)
  return (
    <div role="group" aria-labelledby={labelId(descriptor)} className={PILL_GROUP_CLASS}>
      {options.map((option) => {
        const selected = value !== undefined && isSameValue(option.value, value)
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
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

export function VideoParameterControls({ model, values, onChange }: VideoParameterControlsProps) {
  const descriptors = videoControlDescriptors(model)
  // `count` is excluded from the control descriptors but is still a declared
  // parameter, and the server derives the job row from `parameters.count`.
  const countDescriptor = resolveDescriptor(model, 'count')
  const countOptions = descriptorOptions(countDescriptor)

  if (descriptors.length === 0 && countOptions.length === 0) return null

  function pick(descriptor: ParameterDescriptor, raw: string | number | boolean) {
    onChange(canonicalNameOf(descriptor), marshalDescriptorValue(descriptor, raw))
  }

  function renderControl(descriptor: ParameterDescriptor) {
    const options = descriptorOptions(descriptor)

    if (descriptor.type === 'boolean') {
      // A lone toggle reads far better than 开/关 side by side and keeps the
      // state on `aria-pressed` instead of a raw checkbox.
      const on = effectiveValue(model, descriptor, values) !== false
      return (
        <button
          type="button"
          aria-pressed={on}
          aria-label={descriptorLabel(descriptor, model)}
          onClick={() => pick(descriptor, !on)}
          className={`${PILL_CLASS} ${on ? PILL_SELECTED_CLASS : PILL_IDLE_CLASS}`}
        >
          {on ? (
            <Volume2 aria-hidden="true" className="h-3.5 w-3.5 text-accent-strong" />
          ) : (
            <VolumeX aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          <span>{on ? '开' : '关'}</span>
        </button>
      )
    }

    if (options.length === 0) return null

    if (options.length <= SEGMENTED_MAX_OPTIONS) {
      const unit = canonicalNameOf(descriptor) === 'durationSeconds' ? ' 秒' : ''
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
            {`${optionLabel(descriptor, option)}${option.isDefault ? ' · 默认' : ''}`}
          </option>
        ))}
      </select>
    )
  }

  return (
    <>
      {descriptors.map((descriptor) => (
        <div key={descriptor.name} className="flex flex-col gap-1">
          <span id={labelId(descriptor)} className="px-0.5 text-[11px] font-medium text-muted-foreground">
            {descriptorLabel(descriptor, model)}
          </span>
          {renderControl(descriptor)}
        </div>
      ))}

      {countDescriptor && countOptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span id={labelId(countDescriptor)} className="px-0.5 text-[11px] font-medium text-muted-foreground">
            {descriptorLabel(countDescriptor, model)}
          </span>
          <ValuePills
            descriptor={countDescriptor}
            model={model}
            options={countOptions}
            values={values}
            onChange={onChange}
            unit=" 条"
          />
        </div>
      )}
    </>
  )
}
