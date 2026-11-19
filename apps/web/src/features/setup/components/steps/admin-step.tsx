'use client'

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CheckIcon } from '@phosphor-icons/react'

import { Alert, Badge, Button, Field, Input, iconSize } from '@/shared/components/ui'
import { clientApi } from '@/shared/services/client-api'
import { describeSetupError, isSetupAlreadyComplete, isSetupSessionError } from '../../lib/setup-errors'
import { isPlausibleEmail } from '../../lib/setup-forms'
import { SetupOtpInput } from '../setup-otp-input'
import { SetupStepShell } from '../setup-step-shell'

export interface AdminStepProps {
  /** 服务端 admin 段是否已完成。 */
  complete: boolean
  /** SMTP 段是否已验证——管理员验证码要靠它发信。 */
  smtpReady: boolean
  onDone: () => void | Promise<void>
  onSessionLost: (message: string) => void
}

const RESEND_COOLDOWN_SECONDS = 60
const OTP_LENGTH = 6

/**
 * 创建首个管理员：邮箱 → 一次性验证码 → `POST /setup/admin/verify` 建号并登录。
 * 验证码属于发送时的邮箱，发送后修改输入框不会影响校验地址。
 */
export function AdminStep({ complete, smtpReady, onDone, onSessionLost }: AdminStepProps) {
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | undefined>(undefined)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [otpError, setOtpError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const codeFirstCell = useRef<HTMLInputElement | null>(null)

  const cooling = cooldown > 0

  useEffect(() => {
    if (!cooling) return
    const timer = window.setInterval(() => setCooldown((left) => Math.max(0, left - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooling])

  const send = useMutation({
    mutationFn: (target: string) => clientApi.setup.requestAdmin(target),
    onSuccess: (_result, target) => {
      setSentTo(target)
      setCode('')
      setOtpError(null)
      setCooldown(RESEND_COOLDOWN_SECONDS)
      setNotice({ tone: 'success', text: `验证码已发送至 ${target}，10 分钟内有效。` })
    },
    onError: (error: unknown) => {
      if (isSetupSessionError(error)) {
        onSessionLost(describeSetupError(error, '初始化会话已失效。'))
        return
      }
      // 管理员已经存在（例如上一次安装中断后又回到本步）：刷新状态并前进。
      if (isSetupAlreadyComplete(error)) {
        void onDone()
        return
      }
      setNotice({ tone: 'danger', text: describeSetupError(error, '发送验证码失败，请稍后重试。') })
    },
  })

  const verify = useMutation({
    mutationFn: (value: string) => {
      if (!sentTo) throw new Error('请先发送验证码。')
      return clientApi.setup.verifyAdmin({ email: sentTo, code: value })
    },
    onSuccess: async () => {
      setOtpError(null)
      await onDone()
    },
    onError: (error: unknown) => {
      if (isSetupSessionError(error)) {
        onSessionLost(describeSetupError(error, '初始化会话已失效。'))
        return
      }
      if (isSetupAlreadyComplete(error)) {
        void onDone()
        return
      }
      setOtpError(describeSetupError(error, '创建管理员失败，请稍后重试。'))
      setCode('')
      requestAnimationFrame(() => codeFirstCell.current?.focus())
    },
  })

  if (complete) {
    return (
      <SetupStepShell
        headingId="setup-admin-title"
        title="创建管理员"
        description="首个管理员账号用于登录后台完成后续配置。"
        status={
          <Badge tone="success" icon={<CheckIcon weight="bold" aria-hidden="true" />}>
            已创建
          </Badge>
        }
      >
        <Alert tone="success" role="status" title="管理员账号已就绪">
          首个管理员已创建并登录。完成初始化后即可使用该账号进入后台。
        </Alert>
      </SetupStepShell>
    )
  }

  function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (send.isPending || cooldown > 0) return
    const target = email.trim()
    if (!isPlausibleEmail(target)) {
      setEmailError('请输入有效的邮箱地址。')
      return
    }
    setEmailError(undefined)
    setNotice(null)
    send.mutate(target)
  }

  return (
    <SetupStepShell
      headingId="setup-admin-title"
      title="创建管理员"
      description="管理员邮箱会收到一次性验证码，验证通过后创建首个管理员账号并直接登录。"
      status={<Badge tone="neutral">待创建</Badge>}
    >
      {!smtpReady ? (
        <Alert tone="warning" role="status" title="请先验证 SMTP">
          管理员验证码通过邮件发送。请先在「SMTP 邮件」步骤验证连接，再回来发送验证码。
        </Alert>
      ) : null}

      {notice && !otpError ? (
        <Alert tone={notice.tone} role={notice.tone === 'danger' ? 'alert' : 'status'}>
          {notice.text}
        </Alert>
      ) : null}

      <form noValidate className="flex flex-col gap-5" onSubmit={requestCode}>
        <Field
          id="setup-admin-email"
          label="管理员邮箱"
          required
          error={emailError}
          hint="将成为第一个管理员账号；请使用可正常收信的邮箱。"
        >
          <Input
            type="email"
            size="md"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            disabled={!smtpReady || send.isPending}
            placeholder="admin@example.com"
            onChange={(event) => {
              setEmail(event.target.value)
              setEmailError(undefined)
            }}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="md"
            variant={sentTo ? 'outline' : 'primary'}
            loading={send.isPending}
            disabled={!smtpReady || cooldown > 0 || send.isPending}
          >
            {cooldown > 0 ? `${cooldown} 秒后可重新发送` : sentTo ? '重新发送验证码' : '发送验证码'}
          </Button>
        </div>
      </form>

      {sentTo ? (
        <div className="flex flex-col gap-4 rounded-control border border-border/70 bg-tonal p-4">
          <p className="text-sm text-foreground [overflow-wrap:anywhere]">
            验证码已发送至 <span className="font-mono text-foreground">{sentTo}</span>。输入 {OTP_LENGTH}{' '}
            位验证码后会自动创建管理员。
          </p>

          {otpError ? (
            <Alert tone="danger" role="alert" title="无法创建管理员">
              {otpError}
            </Alert>
          ) : null}

          <SetupOtpInput
            value={code}
            disabled={verify.isPending}
            invalid={Boolean(otpError)}
            autoFocus
            firstInputRef={codeFirstCell}
            onChange={(next) => {
              setCode(next)
              if (otpError) setOtpError(null)
            }}
            onComplete={(full) => {
              if (!verify.isPending) verify.mutate(full)
            }}
          />

          <div>
            <Button
              type="button"
              size="md"
              loading={verify.isPending}
              disabled={code.length !== OTP_LENGTH || verify.isPending}
              onClick={() => verify.mutate(code)}
            >
              创建管理员
            </Button>
          </div>
        </div>
      ) : null}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
        验证码校验通过后，浏览器会同时获得管理员登录会话。
      </p>
    </SetupStepShell>
  )
}
