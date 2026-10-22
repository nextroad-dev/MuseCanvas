'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { SetupClaimResult } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import { Alert, Badge, Button, FormField, Input } from '@/shared/components/ui'
import { CheckIcon as Check } from '@phosphor-icons/react'
import { claimErrorMessage, claimFailureOutcome, stepDefinition } from '../../lib/setup-wizard-state'
import { errorCodeOf, invalidateSetupQueries, requireSetupData } from '../../lib/setup-requests'
import { focusFirstInvalidField } from '@/features/settings-forms/settings-form-shared'
import { StepFrame } from './step-frame'

const FORM_ID = 'setup-claim-form'
const { title, description } = stepDefinition('claim')

/** Claim is the only step that works without a setup session. Once claimed it shows the session state only. */
export function ClaimStep({ claimed }: { claimed: boolean }) {
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const claim = useMutation({
    mutationFn: async () => {
      const res = await api<SetupClaimResult>(API_ENDPOINTS.setup.claim, {
        method: 'POST',
        body: { code: code.trim() },
      })
      return requireSetupData(res, claimErrorMessage(res.error?.code))
    },
    onSuccess: async () => {
      setError(null)
      setCode('')
      await invalidateSetupQueries(queryClient)
    },
    onError: async (err) => {
      const outcome = claimFailureOutcome(errorCodeOf(err))
      if (outcome.kind === 'refetch-status') {
        // Stale status: the server no longer wants a claim code. Refetching drops this step from the
        // wizard, which then resumes at the first incomplete step. No error is shown.
        setError(null)
        await invalidateSetupQueries(queryClient)
        return
      }
      setError(outcome.message)
      requestAnimationFrame(() => focusFirstInvalidField(FORM_ID))
    },
  })

  if (claimed) {
    return (
      <StepFrame
        headingId="setup-step-claim"
        title={title}
        description={description}
        status={<Badge tone="success" icon={<Check weight="bold" aria-hidden="true" />}>已领取</Badge>}
      >
        <Alert tone="success" role="status" title="初始化会话有效">
          领取码已验证。初始化会话有效期 30 分钟，超时后需要重新领取；其余步骤可以随时回来修改。
        </Alert>
      </StepFrame>
    )
  }

  return (
    <StepFrame headingId="setup-step-claim" title={title} description={description}>
      {error ? (
        <Alert tone="danger" role="alert" title="无法领取">
          {error}
        </Alert>
      ) : null}

      <form
        id={FORM_ID}
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          if (claim.isPending) return
          if (!code.trim()) {
            setError(claimErrorMessage('INVALID_INPUT'))
            requestAnimationFrame(() => focusFirstInvalidField(FORM_ID))
            return
          }
          setError(null)
          claim.mutate()
        }}
      >
        <FormField
          label="领取码"
          required
          hint="原样粘贴即可，首尾空格会被忽略。"
        >
          <Input
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
            invalid={Boolean(error)}
            value={code}
            disabled={claim.isPending}
            onChange={(event) => {
              setCode(event.target.value)
              if (error) setError(null)
            }}
          />
        </FormField>
        <div>
          <Button type="submit" loading={claim.isPending}>
            领取并开始
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-3 rounded-control bg-tonal p-4">
        <h3 className="text-sm font-medium text-foreground">领取码在哪里找</h3>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground marker:text-muted-foreground">
          <li>打开 API 服务的日志，查找以 <code className="font-mono text-foreground">[MUSECANVAS SETUP CLAIM]</code> 开头的一行。</li>
          <li>复制该行中 <code className="font-mono text-foreground">code=</code> 后面的值，粘贴到上方。</li>
          <li>领取码 15 分钟内有效且只能使用一次。若部署配置了 SETUP_CLAIM_FILE，则从该文件中读取。</li>
        </ol>
      </div>
    </StepFrame>
  )
}
