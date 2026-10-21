'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { SmtpSettingsDto } from '@musecanvas/contracts'
import type { SetupSmtpTestResult } from '@/shared/types'
import { api } from '@/shared/services/api'
import { Button } from '@/shared/components/ui'
import { SmtpSettingsForm } from '@/features/settings-forms/smtp-settings-form'
import { ConnectionBadge, focusFirstInvalidField } from '@/features/settings-forms/settings-form-shared'
import {
  smtpDraftFromDto,
  toSmtpInput,
  validateSmtpDraft,
} from '@/features/settings-forms/settings-form-state'
import type { FieldErrors, SmtpDraft } from '@/features/settings-forms/settings-form-state'
import {
  invalidateSetupQueries,
  requireSetupData,
  requireVerifiedSetupResult,
  stepErrorMessage,
} from '../../lib/setup-requests'
import { stepDefinition } from '../../lib/setup-wizard-state'
import { StepFrame, StepNotice } from './step-frame'
import type { StepNoticeState } from './step-frame'
import { useServerDraft } from './use-server-draft'

const FORM_ID = 'setup-smtp-form'
const { title, description } = stepDefinition('smtp')

export function SmtpStep({ settings }: { settings: SmtpSettingsDto }) {
  const queryClient = useQueryClient()
  const { baseline, draft, setDraft, adopt } = useServerDraft(settings, smtpDraftFromDto)
  const [errors, setErrors] = useState<FieldErrors<keyof SmtpDraft>>({})
  const [notice, setNotice] = useState<StepNoticeState | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const res = await api<SmtpSettingsDto>(API_ENDPOINTS.setup.smtp, { method: 'POST', body: toSmtpInput(draft, baseline) })
      return requireSetupData(res, '保存 SMTP 设置失败。')
    },
    onSuccess: async (saved) => {
      adopt(saved)
      setNotice({ tone: 'success', text: 'SMTP 设置已保存，但尚未验证。验证通过后才能发送管理员验证码。' })
      await invalidateSetupQueries(queryClient)
    },
    onError: (err) => setNotice({ tone: 'danger', text: stepErrorMessage(err, '保存 SMTP 设置失败，请稍后重试。') }),
  })

  // A verified test saves the draft server-side only after the real connection succeeds.
  const verify = useMutation({
    mutationFn: async () => {
      const res = await api<SetupSmtpTestResult>(API_ENDPOINTS.setup.smtpTest, {
        method: 'POST',
        body: toSmtpInput(draft, baseline),
      })
      return requireVerifiedSetupResult(res, 'SMTP 连接验证未通过，设置未保存。')
    },
    onSuccess: async (saved) => {
      adopt(saved)
      setNotice({ tone: 'success', text: 'SMTP 连接验证通过，设置已保存。此验证不发送邮件，也不保证投递。' })
      await invalidateSetupQueries(queryClient)
    },
    onError: (err) => setNotice({ tone: 'danger', text: stepErrorMessage(err, 'SMTP 连接验证未通过，设置未保存。') }),
  })

  const busy = save.isPending || verify.isPending

  /** Validates the draft first; both actions share the same field-level checks. */
  function run(action: 'save' | 'verify') {
    if (busy) return
    const next = validateSmtpDraft(draft, baseline)
    setErrors(next)
    setNotice(null)
    if (Object.keys(next).length > 0) {
      requestAnimationFrame(() => focusFirstInvalidField(FORM_ID))
      return
    }
    if (action === 'verify') verify.mutate()
    else save.mutate()
  }

  return (
    <StepFrame
      headingId="setup-step-smtp"
      title={title}
      description={description}
      status={<ConnectionBadge status={baseline.status} />}
    >
      <StepNotice notice={notice} />
      <SmtpSettingsForm
        formId={FORM_ID}
        baseline={baseline}
        draft={draft}
        onDraftChange={(patch) => {
          setErrors({})
          setDraft((previous) => ({ ...previous, ...patch }))
        }}
        onSubmit={() => run('verify')}
        disabled={busy}
        errors={errors}
        noValidate
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" loading={verify.isPending} disabled={busy} onClick={() => run('verify')}>
          验证连接并保存
        </Button>
        <Button type="button" variant="secondary" loading={save.isPending} disabled={busy} onClick={() => run('save')}>
          仅保存草稿
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        验证会真实连接发信服务器，但不会发送邮件。密码只写入不回显；留空则保持已保存的密码。
      </p>
    </StepFrame>
  )
}
