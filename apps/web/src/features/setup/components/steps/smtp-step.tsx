'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SetupConfigDto, SmtpTlsMode } from '@musecanvas/contracts'
import { clientApi } from '@/shared/services/client-api'
import { Alert, Badge, Button, Field, Input, Select, Switch } from '@/shared/components/ui'
import { describeSetupError, isSetupSessionError } from '../../lib/setup-errors'
import {
  SMTP_TLS_OPTIONS,
  connectionStatusLabel,
  smtpDraftFromDto,
  toSmtpInput,
  validateSmtpDraft,
} from '../../lib/setup-forms'
import type { SmtpDraft } from '../../lib/setup-forms'
import { SetupStepShell } from '../setup-step-shell'

export interface SmtpStepProps {
  config: SetupConfigDto
  /** 服务端 smtp 段是否已完成（= 连接已验证）。 */
  complete: boolean
  onDone: () => void | Promise<void>
  onSessionLost: (message: string) => void
}

/**
 * SMTP：只有连接测试通过后才会把设置保存并标记为已验证（服务端行为）。
 * 密码是 write-only：读取响应永远不含明文，这里也从不回填。
 */
export function SmtpStep({ config, complete, onDone, onSessionLost }: SmtpStepProps) {
  const [draft, setDraft] = useState<SmtpDraft>(() => smtpDraftFromDto(config.smtp))
  const [errors, setErrors] = useState<ReturnType<typeof validateSmtpDraft>>({})
  const [notice, setNotice] = useState<string | null>(null)

  const verify = useMutation({
    mutationFn: () => clientApi.setup.testSmtp(toSmtpInput(draft)),
    onSuccess: async () => {
      setNotice(null)
      await onDone()
    },
    onError: (error: unknown) => {
      if (isSetupSessionError(error)) {
        onSessionLost(describeSetupError(error, '初始化会话已失效。'))
        return
      }
      setNotice(describeSetupError(error, 'SMTP 连接验证未通过，设置未被保存。'))
    },
  })

  function patch(patchValue: Partial<SmtpDraft>) {
    setDraft((previous) => ({ ...previous, ...patchValue }))
    setNotice(null)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (verify.isPending) return
    const next = validateSmtpDraft(draft)
    setErrors(next)
    setNotice(null)
    if (Object.keys(next).length > 0) return
    verify.mutate()
  }

  const status = config.smtp.status

  return (
    <SetupStepShell
      headingId="setup-smtp-title"
      title="SMTP 邮件"
      description="创建管理员时验证码通过邮件发送，所以先验证 SMTP 连接。验证会真实连接发信服务器，但不会发送邮件。"
      status={<Badge tone={complete ? 'success' : status === 'error' ? 'danger' : 'neutral'}>{complete ? '已验证' : connectionStatusLabel(status)}</Badge>}
    >
      {notice ? (
        <Alert tone="danger" role="alert" title="SMTP 验证未通过">
          {notice}
        </Alert>
      ) : null}

      {complete ? (
        <Alert tone="success" role="status" title="SMTP 已验证">
          当前配置已通过连接验证。如需调整，修改后重新验证即可。
        </Alert>
      ) : null}

      <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field id="setup-smtp-host" label="服务器地址" required error={errors.host} hint="例如 smtp.example.com。">
            <Input
              value={draft.host}
              disabled={verify.isPending}
              placeholder="smtp.example.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => patch({ host: event.target.value })}
            />
          </Field>

          <Field id="setup-smtp-port" label="端口" required error={errors.port} hint="STARTTLS 通常 587，隐式 TLS 通常 465。">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={draft.port}
              disabled={verify.isPending}
              placeholder="587"
              onChange={(event) => patch({ port: event.target.value })}
            />
          </Field>
        </div>

        <Field id="setup-smtp-tls" label="加密方式" required>
          <Select
            value={draft.tlsMode}
            disabled={verify.isPending}
            onChange={(event) => patch({ tlsMode: event.target.value as SmtpTlsMode })}
          >
            {SMTP_TLS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field id="setup-smtp-username" label="用户名" hint="留空表示不需要认证。">
            <Input
              value={draft.username}
              disabled={verify.isPending}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => patch({ username: event.target.value })}
            />
          </Field>

          <Field
            id="setup-smtp-password"
            label="密码 / 授权码"
            error={errors.password}
            hint={
              config.smtp.hasSecret
                ? '已保存密码（只写不回显）；留空保持不变。'
                : '多数邮件服务商使用单独生成的授权码。'
            }
          >
            <Input
              type="password"
              value={draft.password}
              disabled={verify.isPending || draft.clearPassword}
              autoComplete="new-password"
              placeholder={config.smtp.hasSecret ? '••••••••（留空保持不变）' : 'SMTP 密码'}
              onChange={(event) => patch({ password: event.target.value })}
            />
          </Field>
        </div>

        {config.smtp.hasSecret ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-tonal p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">清除已保存的密码</span>
              <span className="text-xs text-muted-foreground">
                需要换用无认证的发信方式时再打开；验证通过后才会生效。
              </span>
            </div>
            <Switch
              checked={draft.clearPassword}
              aria-label="清除已保存的 SMTP 密码"
              disabled={verify.isPending}
              onCheckedChange={(checked) => patch({ clearPassword: checked, ...(checked ? { password: '' } : {}) })}
            />
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field
            id="setup-smtp-from-address"
            label="发件人邮箱"
            error={errors.fromAddress}
            hint="留空时默认使用用户名。"
          >
            <Input
              type="email"
              inputMode="email"
              value={draft.fromAddress}
              disabled={verify.isPending}
              placeholder="noreply@example.com"
              onChange={(event) => patch({ fromAddress: event.target.value })}
            />
          </Field>

          <Field id="setup-smtp-from-name" label="发件人名称" hint="可选，例如 MuseCanvas。">
            <Input
              value={draft.fromName}
              disabled={verify.isPending}
              placeholder="MuseCanvas"
              onChange={(event) => patch({ fromName: event.target.value })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={verify.isPending}>
            验证连接并保存
          </Button>
          <span className="text-xs text-muted-foreground">
            连接失败时不会保存任何改动；已保存的密码不受影响。
          </span>
        </div>
      </form>
    </SetupStepShell>
  )
}
