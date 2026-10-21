'use client'

import { FormField, Input, Select } from '@/shared/components/ui'
import type { SmtpSettingsDto, SmtpTlsMode } from '@musecanvas/contracts'
import type { SmtpDraft } from './settings-form-state'

export type SmtpDraftErrors = Partial<Record<keyof SmtpDraft, string>>

export interface SmtpSettingsFormProps {
  formId: string
  /** Stored settings: supplies placeholders and the "secret already set" hint. */
  baseline: SmtpSettingsDto
  draft: SmtpDraft
  onDraftChange: (patch: Partial<SmtpDraft>) => void
  onSubmit: () => void
  disabled?: boolean
  errors?: SmtpDraftErrors
  noValidate?: boolean
}

/** SMTP fields only. The owning screen decides how a save or a connection test is run. */
export function SmtpSettingsForm({
  formId,
  baseline,
  draft,
  onDraftChange,
  onSubmit,
  disabled = false,
  errors,
  noValidate,
}: SmtpSettingsFormProps) {
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
          <FormField label="发信服务器" hint="留空表示保持当前值不变。" error={errors?.host}>
            <Input
              type="text"
              placeholder="smtp.example.com"
              value={draft.host}
              onChange={(e) => onDraftChange({ host: e.target.value })}
            />
          </FormField>
          <FormField label="端口" error={errors?.port}>
            <Input
              type="number"
              min={1}
              max={65535}
              placeholder={baseline.port === null ? '465' : String(baseline.port)}
              value={draft.port}
              onChange={(e) => onDraftChange({ port: e.target.value })}
            />
          </FormField>
          <FormField label="加密方式">
            <Select value={draft.tlsMode} onChange={(e) => onDraftChange({ tlsMode: e.target.value as SmtpTlsMode })}>
              <option value="implicit_tls">隐式 TLS（465）</option>
              <option value="starttls">STARTTLS（587）</option>
              <option value="none">不加密</option>
            </Select>
          </FormField>
          <FormField label="登录用户名">
            <Input
              type="text"
              autoComplete="off"
              value={draft.username}
              onChange={(e) => onDraftChange({ username: e.target.value })}
            />
          </FormField>
          <FormField
            label="登录密码 / 授权码"
            hint={baseline.hasSecret ? '已配置密钥，留空则保持不变。' : '密钥仅写入，不会回显。'}
          >
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={baseline.hasSecret ? '••••••••' : '未设置'}
              value={draft.password}
              onChange={(e) => onDraftChange({ password: e.target.value })}
            />
          </FormField>
          <FormField label="发件地址" error={errors?.fromAddress}>
            <Input
              type="email"
              value={draft.fromAddress}
              onChange={(e) => onDraftChange({ fromAddress: e.target.value })}
            />
          </FormField>
          <FormField label="发件人名称">
            <Input
              type="text"
              maxLength={120}
              value={draft.fromName}
              onChange={(e) => onDraftChange({ fromName: e.target.value })}
            />
          </FormField>
        </div>
      </fieldset>
    </form>
  )
}
