'use client'

import {
  useEffect,
  useState } from 'react'
import { CaretDownIcon as ChevronDown } from '@phosphor-icons/react'
import { Switch } from '@/shared/components/ui/switch'
import { Button,
  Dialog,
  Input,
  SegmentedControl,
  Select,
} from '@/shared/components/ui'
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
  parameterIssues,
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
  disabled?: boolean
}

/** Past this many options a segmented row stops fitting the control bar. */
const SEGMENTED_MAX_OPTIONS = 6

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

export function MediaParameterControls({ model, values, onChange, countUnit, disabled = false }: MediaParameterControlsProps) {
  // Visibility depends on the current values, because a `dependsOn` parameter is
  // only offered while its controlling parameter holds a matching value.
  const controls = mediaControlDescriptors(model, values)
  const advancedControls = controls.filter((descriptor) => isAdvancedParameter(descriptor))
  const primaryControls = controls.filter((descriptor) => !isAdvancedParameter(descriptor))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  useEffect(() => { if (disabled) setAdvancedOpen(false) }, [disabled])
  const advancedIssues = parameterIssues(model, values).filter((issue) => advancedControls.some((descriptor) => descriptor.name === issue.parameter || canonicalNameOf(descriptor) === issue.parameter))

  const countDescriptor = resolveDescriptor(model, 'count')
  const countOptions = descriptorOptions(countDescriptor)

  if (controls.length === 0 && countOptions.length === 0) return null

  function pick(descriptor: ParameterDescriptor, raw: ParameterValue) {
    if (!disabled) onChange(canonicalNameOf(descriptor), marshalDescriptorValue(descriptor, raw))
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
        <Select
          size="sm"
          width="content"
          aria-labelledby={labelId(descriptor)}
          value={value === undefined ? '' : String(value)}
          onChange={(event) => pick(descriptor, event.target.value)}
        >
          {options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {`${option.label}${unit}${option.isDefault ? ' · 默认' : ''}`}
            </option>
          ))}
        </Select>
      )
    }

    return (
      <ValueSegments
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
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-wrap items-end gap-3 border-0 p-0">
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
          <ValueSegments
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
        <>
          <Button type="button" variant="secondary" size="sm" disabled={disabled} aria-haspopup="dialog" onClick={() => setAdvancedOpen(true)} icon={<ChevronDown weight="bold" aria-hidden="true" />}>
            {advancedIssues.length > 0 ? '检查更多参数' : '更多参数'}
          </Button>
          <Dialog open={advancedOpen && !disabled} onClose={() => setAdvancedOpen(false)} title="更多参数" size="wide" description="参数范围与默认值来自当前模型；修改仅更新草稿，不会提交。" footer={<Button variant="secondary" onClick={() => setAdvancedOpen(false)}>完成</Button>}>
            <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-wrap items-start gap-4 border-0 p-0">
              {advancedControls.map((descriptor) => (
                <ParameterField key={descriptor.name} descriptor={descriptor} model={model}>
                  {renderControl(descriptor)}
                  {advancedIssues.filter((issue) => issue.parameter === descriptor.name || issue.parameter === canonicalNameOf(descriptor)).map((issue) => <p key={issue.parameter} role="alert" className="text-xs text-danger">{issue.message}</p>)}
                </ParameterField>
              ))}
            </fieldset>
          </Dialog>
        </>
      )}
    </fieldset>
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
    <Tag className="flex max-w-full flex-col gap-1 [&>[role=radiogroup]]:max-w-full [&>[role=radiogroup]]:overflow-x-auto">
      <span id={labelId(descriptor)} className="px-0.5 text-overline text-muted-foreground">
        {label}
      </span>
      {children}
      {descriptor.description && (
        <span className="px-0.5 text-xs leading-relaxed text-muted-foreground">
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
  const name = descriptor.label ?? descriptor.name
  return (
    <div role="group" aria-label={name} className="flex items-center gap-2">
      <input
        type="range"
        aria-label={name}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={Number.isFinite(numeric) ? numeric : bounds.min}
        onChange={(event) => onChange(marshalDescriptorValue(descriptor, event.target.value))}
        className="h-1 w-28 accent-[var(--color-primary)]"
      />
      <Input
        type="number"
        size="sm"
        aria-label={`${name} 数值`}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={Number.isFinite(numeric) ? numeric : bounds.min}
        onChange={(event) => onChange(marshalDescriptorValue(descriptor, event.target.value))}
        className="w-20"
      />
    </div>
  )
}

function ValueSegments({
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
    <SegmentedControl
      size="sm"
      labelledBy={labelId(descriptor)}
      // The group works in string space (a native control can only ever hand back
      // a string); `marshalDescriptorValue` puts the descriptor's own type back on
      // the way out, so an integer parameter still writes a number.
      value={value === undefined ? undefined : String(value)}
      items={options.map((option) => ({
        value: String(option.value),
        title: option.description,
        label: (
          <>
            <span>{`${option.label}${unit}`}</span>
            {option.isDefault && <span className="text-xs font-normal text-muted-foreground">默认</span>}
          </>
        ),
      }))}
      onChange={(next) => onChange(canonicalNameOf(descriptor), marshalDescriptorValue(descriptor, next))}
    />
  )
}

/** Exported so the console can mirror the same key choice when it writes state. */
export { wireType }
