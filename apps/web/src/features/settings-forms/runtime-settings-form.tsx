'use client'

import { FormField, Input } from '@/shared/components/ui'
import { runtimeFieldDefs } from './settings-form-state'
import type { FieldErrors, RuntimeDraft, RuntimeKey } from './settings-form-state'

export type RuntimeDraftErrors = FieldErrors<RuntimeKey>

export interface RuntimeSettingsFormProps {
  formId: string
  draft: RuntimeDraft
  onDraftChange: (patch: Partial<RuntimeDraft>) => void
  onSubmit: () => void
  disabled?: boolean
  errors?: RuntimeDraftErrors
  noValidate?: boolean
}

/** Runtime guard-rail fields. Cross-field checks are computed by the owner and passed in as `errors`. */
export function RuntimeSettingsForm({
  formId,
  draft,
  onDraftChange,
  onSubmit,
  disabled = false,
  errors,
  noValidate,
}: RuntimeSettingsFormProps) {
  return (
    <form
      id={formId}
      noValidate={noValidate}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <fieldset disabled={disabled} className="min-w-0">
        <div className="grid min-w-0 gap-6 @min-[560px]/fields:grid-cols-2">
          {runtimeFieldDefs.map(({ key, label, min, max }) => (
            <FormField key={key} label={label} error={errors?.[key]}>
              <Input
                type="number"
                min={min}
                max={max}
                value={draft[key]}
                onChange={(e) => onDraftChange({ [key]: e.target.value })}
              />
            </FormField>
          ))}
        </div>
      </fieldset>
    </form>
  )
}
