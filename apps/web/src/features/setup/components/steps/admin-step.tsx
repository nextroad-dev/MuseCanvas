'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import { Alert, Badge, Button, FormField, Input } from '@/shared/components/ui'
import { OtpInput } from '@/features/auth/components/otp-input'
import { focusFirstInvalidField } from '@/features/settings-forms/settings-form-shared'
import { isPlausibleEmail } from '@/features/settings-forms/settings-form-state'
import { CheckIcon as Check } from '@phosphor-icons/react'
import {
  ADMIN_OTP_LENGTH,
  adminRequestErrorMessage,
  adminVerifyErrorMessage,
  resendCooldownRemaining,
  stepDefinition,
} from '../../lib/setup-wizard-state'
import { errorCodeOf, invalidateSetupQueries, requireSetupData } from '../../lib/setup-requests'
import { StepFrame, StepNotice } from './step-frame'
import type { StepNoticeState } from './step-frame'

const FORM_ID = 'setup-admin-form'
const { title, description } = stepDefinition('admin')

/**
 * Creates the first administrator through a one-time code e-mailed by SMTP. The
 * code belongs to the address it was sent to, so editing the field afterwards does
 * not change what verification checks.
 */
export function AdminStep({ complete, smtpReady }: { complete: boolean; smtpReady: boolean }) {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | undefined>(undefined)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState<StepNoticeState | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const codeFirstCell = useRef<HTMLInputElement | null>(null)

  const cooldown = resendCooldownRemaining(sentAt, now)
  const cooling = cooldown > 0

  useEffect(() => {
    if (!cooling) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooling])

  const send = useMutation({
    mutationFn: async (target: string) => {
      const res = await api<{ accepted: boolean }>(API_ENDPOINTS.setup.adminRequest, {
        method: 'POST',
        body: { email: target },
      })
      return requireSetupData(res, adminRequestErrorMessage(res.error?.code))
    },
    onSuccess: (_data, target) => {
      const stamp = Date.now()
      setSentTo(target)
      setSentAt(stamp)
      setNow(stamp)
      setCode('')
      setVerifyError(null)
      setNotice({ tone: 'success', text: `验证码已发送至 ${target}，10 分钟内有效。` })
    },
    onError: (err) => setNotice({ tone: 'danger', text: adminRequestErrorMessage(errorCodeOf(err)) }),
  })

  const verify = useMutation({
    mutationFn: async (value: string) => {
      if (!sentTo) throw new Error('请先发送验证码')
      const res = await api<{ user: unknown }>(API_ENDPOINTS.setup.adminVerify, {
        method: 'POST',
        body: { email: sentTo, code: value },
      })
      return requireSetupData(res, adminVerifyErrorMessage(res.error?.code))
    },
    onSuccess: async () => {
      setVerifyError(null)
      setNotice({ tone: 'success', text: '管理员账号已创建。' })
      await invalidateSetupQueries(queryClient)
    },
    onError: (err) => {
      setVerifyError(adminVerifyErrorMessage(errorCodeOf(err)))
      setCode('')
      requestAnimationFrame(() => codeFirstCell.current?.focus())
    },
  })

  if (complete) {
    return (
      <StepFrame
        headingId="setup-step-admin"
        title={title}
        description={description}
        status={<Badge tone="success" icon={<Check weight="bold" aria-hidden="true" />}>已创建</Badge>}
      >
        <Alert tone="success" role="status" title="管理员账号已就绪">
          初始化完成后将进入管理后台。
        </Alert>
      </StepFrame>
    )
  }

  function requestCode() {
    if (send.isPending || cooling || !smtpReady) return
    const target = email.trim()
    if (!isPlausibleEmail(target)) {
      setEmailError('请输入有效的邮箱地址。')
      requestAnimationFrame(() => focusFirstInvalidField(FORM_ID))
      return
    }
    setEmailError(undefined)
    setNotice(null)
    send.mutate(target)
  }

  return (
    <StepFrame
      headingId="setup-step-admin"
      title={title}
      description={description}
      status={<Badge tone="neutral">待创建</Badge>}
    >
      {!smtpReady ? (
        <Alert tone="warning" role="status" title="请先验证 SMTP">
          管理员验证码通过邮件发送。请先在“邮件”步骤验证 SMTP 连接，再发送验证码。
        </Alert>
      ) : null}
      <StepNotice notice={notice} />

      <form
        id={FORM_ID}
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          requestCode()
        }}
      >
        <FormField
          label="管理员邮箱"
          required
          hint="该邮箱将成为第一个管理员账号，并接收一次性验证码。"
          error={emailError}
        >
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            value={email}
            disabled={!smtpReady || send.isPending}
            onChange={(event) => {
              setEmail(event.target.value)
              setEmailError(undefined)
            }}
          />
        </FormField>
        <div>
          <Button
            type="submit"
            variant={sentAt === null ? 'primary' : 'secondary'}
            loading={send.isPending}
            disabled={!smtpReady || cooling || send.isPending}
          >
            {cooling ? `${cooldown} 秒后可重新发送` : sentAt === null ? '发送验证码' : '重新发送验证码'}
          </Button>
        </div>
      </form>

      {sentTo ? (
        <div className="flex flex-col gap-4 rounded-control bg-tonal p-4">
          <p className="text-sm text-foreground">
            验证码已发送至 <span className="font-mono">{sentTo}</span>。输入 {ADMIN_OTP_LENGTH} 位验证码后会自动创建管理员。
          </p>
          {verifyError ? (
            <Alert tone="danger" role="alert" title="无法创建管理员">
              {verifyError}
            </Alert>
          ) : null}
          <OtpInput
            value={code}
            disabled={verify.isPending}
            invalid={Boolean(verifyError)}
            firstInputRef={codeFirstCell}
            onChange={(next) => {
              setCode(next)
              if (verifyError) setVerifyError(null)
            }}
            onComplete={(full) => {
              if (!verify.isPending) verify.mutate(full)
            }}
          />
          <div>
            <Button
              type="button"
              loading={verify.isPending}
              disabled={code.length !== ADMIN_OTP_LENGTH || verify.isPending}
              onClick={() => verify.mutate(code)}
            >
              创建管理员
            </Button>
          </div>
        </div>
      ) : null}
    </StepFrame>
  )
}
