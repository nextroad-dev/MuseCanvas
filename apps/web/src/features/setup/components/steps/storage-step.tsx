'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { StorageSettingsDto } from '@musecanvas/contracts'
import type { SetupStorageTestResult } from '@/shared/types'
import { api } from '@/shared/services/api'
import { Button } from '@/shared/components/ui'
import { StorageSettingsForm } from '@/features/settings-forms/storage-settings-form'
import { ConnectionBadge, focusFirstInvalidField } from '@/features/settings-forms/settings-form-shared'
import {
  storageDraftFromDto,
  toStorageInput,
  validateStorageDraft,
} from '@/features/settings-forms/settings-form-state'
import type { FieldErrors, StorageDraft } from '@/features/settings-forms/settings-form-state'
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

const FORM_ID = 'setup-storage-form'
const { title, description } = stepDefinition('storage')

export function StorageStep({ settings }: { settings: StorageSettingsDto }) {
  const queryClient = useQueryClient()
  const { baseline, draft, setDraft, adopt } = useServerDraft(settings, storageDraftFromDto)
  const [errors, setErrors] = useState<FieldErrors<keyof StorageDraft>>({})
  const [notice, setNotice] = useState<StepNoticeState | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const res = await api<StorageSettingsDto>(API_ENDPOINTS.setup.storage, { method: 'POST', body: toStorageInput(draft, baseline) })
      return requireSetupData(res, '保存对象存储设置失败。')
    },
    onSuccess: async (saved) => {
      adopt(saved)
      setNotice({ tone: 'success', text: '对象存储设置已保存，但尚未验证。' })
      await invalidateSetupQueries(queryClient)
    },
    onError: (err) => setNotice({ tone: 'danger', text: stepErrorMessage(err, '保存对象存储设置失败，请稍后重试。') }),
  })

  // The test runs against the chosen driver; only a passing test is persisted as verified.
  const verify = useMutation({
    mutationFn: async () => {
      const res = await api<SetupStorageTestResult>(API_ENDPOINTS.setup.storageTest, {
        method: 'POST',
        body: toStorageInput(draft, baseline),
      })
      return requireVerifiedSetupResult(res, '对象存储连接测试未通过，设置未保存。')
    },
    onSuccess: async (saved) => {
      adopt(saved)
      setNotice({ tone: 'success', text: '对象存储连接测试通过，设置已保存并标记为已验证。' })
      await invalidateSetupQueries(queryClient)
    },
    onError: (err) => setNotice({ tone: 'danger', text: stepErrorMessage(err, '对象存储连接测试未通过，设置未保存。') }),
  })

  const busy = save.isPending || verify.isPending

  function run(action: 'save' | 'verify') {
    if (busy) return
    const next = validateStorageDraft(draft, baseline)
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
      headingId="setup-step-storage"
      title={title}
      description={description}
      status={<ConnectionBadge status={baseline.status} />}
    >
      <StepNotice notice={notice} />
      <StorageSettingsForm
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
        连接测试会在存储中读写一个测试对象，成功后才保存。本地磁盘模式下，API 与 Worker 必须挂载同一目录。
      </p>
    </StepFrame>
  )
}
