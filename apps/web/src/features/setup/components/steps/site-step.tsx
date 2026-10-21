'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { SiteSettingsDto } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import { Badge, Button } from '@/shared/components/ui'
import { SiteSettingsForm } from '@/features/settings-forms/site-settings-form'
import { focusFirstInvalidField } from '@/features/settings-forms/settings-form-shared'
import {
  siteDraftFromDto,
  toSiteInput,
  validateSiteDraft,
} from '@/features/settings-forms/settings-form-state'
import type { FieldErrors, SiteDraft } from '@/features/settings-forms/settings-form-state'
import { invalidateSetupQueries, requireSetupData, stepErrorMessage } from '../../lib/setup-requests'
import { stepDefinition } from '../../lib/setup-wizard-state'
import { StepFrame, StepNotice } from './step-frame'
import type { StepNoticeState } from './step-frame'
import { useServerDraft } from './use-server-draft'

const FORM_ID = 'setup-site-form'
const { title, description } = stepDefinition('site')

export function SiteStep({ settings, complete }: { settings: SiteSettingsDto; complete: boolean }) {
  const queryClient = useQueryClient()
  const { draft, setDraft, adopt } = useServerDraft(settings, siteDraftFromDto)
  const [errors, setErrors] = useState<FieldErrors<keyof SiteDraft>>({})
  const [notice, setNotice] = useState<StepNoticeState | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const res = await api<SiteSettingsDto>(API_ENDPOINTS.setup.site, { method: 'POST', body: toSiteInput(draft) })
      return requireSetupData(res, '保存站点信息失败。')
    },
    onSuccess: async (saved) => {
      adopt(saved)
      setNotice({ tone: 'success', text: '站点信息已保存。' })
      await invalidateSetupQueries(queryClient)
    },
    onError: (err) => setNotice({ tone: 'danger', text: stepErrorMessage(err, '保存站点信息失败，请稍后重试。') }),
  })

  function submit() {
    if (save.isPending) return
    const next = validateSiteDraft(draft)
    setErrors(next)
    setNotice(null)
    if (Object.keys(next).length > 0) {
      requestAnimationFrame(() => focusFirstInvalidField(FORM_ID))
      return
    }
    save.mutate()
  }

  return (
    <StepFrame
      headingId="setup-step-site"
      title={title}
      description={description}
      status={<Badge tone={complete ? 'success' : 'neutral'}>{complete ? '已保存' : '待保存'}</Badge>}
    >
      <StepNotice notice={notice} />
      <SiteSettingsForm
        formId={FORM_ID}
        draft={draft}
        onDraftChange={(patch) => {
          setErrors({})
          setDraft((previous) => ({ ...previous, ...patch }))
        }}
        onSubmit={submit}
        disabled={save.isPending}
        errors={errors}
        noValidate
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" form={FORM_ID} loading={save.isPending}>
          保存站点信息
        </Button>
      </div>
    </StepFrame>
  )
}
