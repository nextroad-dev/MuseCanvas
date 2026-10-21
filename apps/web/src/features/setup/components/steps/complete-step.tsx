'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { RuntimeSettingsDto, SetupCompletionPayload } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import { Badge, Button, Divider } from '@/shared/components/ui'
import { RuntimeSettingsForm } from '@/features/settings-forms/runtime-settings-form'
import { focusFirstInvalidField } from '@/features/settings-forms/settings-form-shared'
import {
  runtimeDraftFromValues,
  resolveRuntimeValues,
  runtimeDraftChanged,
  validateRuntimeDraft,
} from '@/features/settings-forms/settings-form-state'
import type { FieldErrors, RuntimeKey } from '@/features/settings-forms/settings-form-state'
import {
  errorCodeOf,
  invalidateSetupQueries,
  requireSetupData,
  stepErrorMessage,
} from '../../lib/setup-requests'
import { stepDefinition } from '../../lib/setup-wizard-state'
import type { SetupChecklistItem } from '../../lib/setup-wizard-state'
import { StepFrame, StepNotice } from './step-frame'
import type { StepNoticeState } from './step-frame'
import { useServerDraft } from './use-server-draft'

const FORM_ID = 'setup-runtime-form'
const { title, description } = stepDefinition('complete')

/**
 * Runtime parameters, the review checklist and the final action. Completion is the
 * only write that flips the server state; the checklist mirrors the gate it enforces.
 */
export function CompleteStep({
  runtime,
  checklist,
  canComplete,
}: {
  runtime: RuntimeSettingsDto
  checklist: SetupChecklistItem[]
  canComplete: boolean
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { baseline, draft, setDraft, adopt } = useServerDraft(runtime, runtimeDraftFromValues)
  const [errors, setErrors] = useState<FieldErrors<RuntimeKey>>({})
  const [notice, setNotice] = useState<StepNoticeState | null>(null)
  const dirty = runtimeDraftChanged(draft, baseline)

  const saveRuntime = useMutation({
    mutationFn: async () => {
      const res = await api<RuntimeSettingsDto>(API_ENDPOINTS.setup.runtime, {
        method: 'POST',
        body: resolveRuntimeValues(draft, baseline),
      })
      return requireSetupData(res, '保存运行时限制失败。')
    },
    onSuccess: async (saved) => {
      adopt(saved)
      setNotice({ tone: 'success', text: '运行时限制已保存。Worker 将在缓存刷新后生效。' })
      await invalidateSetupQueries(queryClient)
    },
    onError: (err) => setNotice({ tone: 'danger', text: stepErrorMessage(err, '保存运行时限制失败，请稍后重试。') }),
  })

  const finish = useMutation({
    mutationFn: async () => {
      const res = await api<SetupCompletionPayload>(API_ENDPOINTS.setup.complete, { method: 'POST' })
      return requireSetupData(res, '完成初始化失败。')
    },
    onSuccess: async () => {
      await invalidateSetupQueries(queryClient)
      router.push('/admin')
    },
    onError: (err) => {
      setNotice({
        tone: 'danger',
        text: errorCodeOf(err) === 'SETUP_INCOMPLETE'
          ? '仍有必填步骤未完成，请检查下方清单。'
          : stepErrorMessage(err, '完成初始化失败，请稍后重试。'),
      })
    },
  })

  const busy = saveRuntime.isPending || finish.isPending
  const blockedReason = dirty
    ? '运行时限制有未保存的更改，请先保存。'
    : !canComplete
      ? '尚有未完成的步骤，请在对应步骤中完成后再回到这里。'
      : null

  function submitRuntime() {
    if (busy) return
    const next = validateRuntimeDraft(draft, baseline)
    setErrors(next)
    setNotice(null)
    if (Object.keys(next).length > 0) {
      requestAnimationFrame(() => focusFirstInvalidField(FORM_ID))
      return
    }
    saveRuntime.mutate()
  }

  return (
    <StepFrame
      headingId="setup-step-complete"
      title={title}
      description={description}
      status={<Badge tone={canComplete ? 'success' : 'warning'}>{canComplete ? '可以完成' : '尚未就绪'}</Badge>}
    >
      <StepNotice notice={notice} />

      <section aria-labelledby="setup-runtime-title" className="flex min-w-0 flex-col gap-4">
        <h3 id="setup-runtime-title" className="text-module text-foreground">
          运行时限制
        </h3>
        <RuntimeSettingsForm
          formId={FORM_ID}
          draft={draft}
          onDraftChange={(patch) => {
            setErrors({})
            setDraft((previous) => ({ ...previous, ...patch }))
          }}
          onSubmit={submitRuntime}
          disabled={busy}
          errors={errors}
          noValidate
        />
        <div>
          <Button type="submit" form={FORM_ID} variant="secondary" loading={saveRuntime.isPending} disabled={busy}>
            保存运行时限制
          </Button>
        </div>
      </section>

      <Divider />

      <section aria-labelledby="setup-checklist-title" className="flex min-w-0 flex-col gap-3">
        <h3 id="setup-checklist-title" className="text-module text-foreground">
          检查清单
        </h3>
        <ul className="flex flex-col divide-y divide-border rounded-control bg-tonal px-4">
          {checklist.map((item) => (
            <li key={item.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="text-sm text-foreground">{item.label}</span>
              <Badge tone={item.complete ? 'success' : 'warning'}>{item.complete ? '已完成' : '待完成'}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-3">
        <div>
          <Button
            type="button"
            loading={finish.isPending}
            disabled={busy || dirty || !canComplete}
            onClick={() => {
              setNotice(null)
              finish.mutate()
            }}
          >
            完成初始化
          </Button>
        </div>
        {blockedReason ? (
          <p role="status" className="text-sm text-muted-foreground">
            {blockedReason}
          </p>
        ) : null}
      </div>
    </StepFrame>
  )
}
