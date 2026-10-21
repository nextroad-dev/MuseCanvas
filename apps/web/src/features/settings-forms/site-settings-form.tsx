'use client'

import { FieldGroup, FormField, Input } from '@/shared/components/ui'
import type { SiteDraft } from './settings-form-state'

export type SiteDraftErrors = Partial<Record<keyof SiteDraft, string>>

export interface SiteSettingsFormProps {
  /** Id of the `<form>`. Footer buttons outside the form submit through it. */
  formId: string
  draft: SiteDraft
  onDraftChange: (patch: Partial<SiteDraft>) => void
  onSubmit: () => void
  /** Locks every field while the owning screen is busy. */
  disabled?: boolean
  errors?: SiteDraftErrors
  /** Lets the owning screen report validation itself instead of the browser bubble. */
  noValidate?: boolean
}

/**
 * Site fields only: the owning screen supplies the section chrome, the mutation and
 * the save/cancel controls. Lays out in two columns from the nearest `@container/fields`.
 */
export function SiteSettingsForm({
  formId,
  draft,
  onDraftChange,
  onSubmit,
  disabled = false,
  errors,
  noValidate,
}: SiteSettingsFormProps) {
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
        <FieldGroup>
          <FormField
            label="站点名称"
            required
            hint="显示在标题、邮件与页面元信息中，最长 120 字符。"
            error={errors?.siteName}
          >
            <Input
              type="text"
              maxLength={120}
              value={draft.siteName}
              onChange={(e) => onDraftChange({ siteName: e.target.value })}
            />
          </FormField>
          <FormField
            label="站点地址（可选）"
            hint="必须是 HTTPS 根地址，不能带路径、查询参数或认证信息；留空则回退到服务端环境变量推导的地址。"
            error={errors?.siteUrl}
          >
            <Input
              type="text"
              placeholder="https://musecanvas.example.com"
              value={draft.siteUrl}
              onChange={(e) => onDraftChange({ siteUrl: e.target.value })}
            />
          </FormField>
        </FieldGroup>
      </fieldset>
    </form>
  )
}
