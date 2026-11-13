'use client'

import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { TrashIcon as Trash } from '@phosphor-icons/react'
import type { SmtpSettingsDto, SmtpSettingsInput, SmtpTlsMode } from '@musecanvas/contracts'
import { Alert } from '@/shared/components/ui/alert'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Field, FieldGroup } from '@/shared/components/ui/field'
import { Input } from '@/shared/components/ui/input'
import { Select } from '@/shared/components/ui/select'
import { useToast } from '@/shared/components/ui/toast'
import { iconSize } from '@/shared/components/ui/size'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import { SMTP_TLS_OPTIONS, validateSmtpForm } from '@/features/admin/lib/admin-settings-forms'
import type { SmtpFormValues } from '@/features/admin/lib/admin-settings-forms'
import { clientApi } from '@/shared/services/client-api'
import { AdminSettingsConfirmDialog } from './admin-settings-confirm-dialog'

const STATUS_LABEL: Record<SmtpSettingsDto['status'], { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  not_configured: { label: '未配置', tone: 'neutral' },
  configured: { label: '已保存未验证', tone: 'info' },
  verified: { label: '连接已验证', tone: 'success' },
  error: { label: '读取密钥失败', tone: 'danger' },
}

function smtpDraft(settings: SmtpSettingsDto): SmtpFormValues {
  return {
    host: settings.host ?? '',
    port: settings.port === null ? '' : String(settings.port),
    tlsMode: settings.tlsMode,
    username: settings.username ?? '',
    password: '',
    fromAddress: settings.fromAddress ?? '',
    fromName: settings.fromName ?? '',
  }
}

function buildSmtpInput(values: SmtpFormValues, password?: string): SmtpSettingsInput {
  const input: SmtpSettingsInput = {
    host: values.host.trim() === '' ? null : values.host.trim(),
    port: values.port.trim() === '' ? null : Number(values.port),
    tlsMode: values.tlsMode,
    username: values.username.trim() === '' ? null : values.username.trim(),
    fromAddress: values.fromAddress.trim() === '' ? null : values.fromAddress.trim(),
    fromName: values.fromName.trim() === '' ? null : values.fromName.trim(),
  }
  if (password !== undefined) input.password = password
  return input
}

export interface AdminSettingsSmtpProps {
  settings: SmtpSettingsDto
  onSaved: (settings: SmtpSettingsDto) => void
}

/** SMTP 分区：保存、测试连接（成功即保存）、危险区清空密码。 */
export function AdminSettingsSmtp({ settings, onSaved }: AdminSettingsSmtpProps) {
  const { toast } = useToast()
  const [values, setValues] = useState<SmtpFormValues>(() => smtpDraft(settings))
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [confirmClear, setConfirmClear] = useState(false)
  const status = STATUS_LABEL[settings.status]

  useEffect(() => {
    setValues(smtpDraft(settings))
    setErrors({})
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: (input: SmtpSettingsInput) => clientApi.setup.updateSmtp(input),
    onSuccess: (saved) => {
      onSaved(saved)
      setValues((current) => ({ ...current, password: '' }))
      toast.success('SMTP 设置已保存')
    },
    onError: (error) => toast.error('保存 SMTP 设置失败', adminErrorMessage(error)),
  })

  const testMutation = useMutation({
    mutationFn: (input: SmtpSettingsInput) => clientApi.setup.testSmtp(input),
    onSuccess: (result) => {
      onSaved(result.settings)
      setValues((current) => ({ ...current, password: '' }))
      toast.success('SMTP 连接验证成功', '验证通过后设置已自动保存。')
    },
    onError: (error) => toast.error('SMTP 连接测试失败', adminErrorMessage(error)),
  })

  const clearMutation = useMutation({
    mutationFn: () => clientApi.setup.updateSmtp({ password: '' }),
    onSuccess: (saved) => {
      onSaved(saved)
      setConfirmClear(false)
      toast.success('已清空保存的 SMTP 密码')
    },
    onError: (error) => toast.error('清空 SMTP 密码失败', adminErrorMessage(error)),
  })

  const busy = saveMutation.isPending || testMutation.isPending

  function patchValues(patch: Partial<SmtpFormValues>) {
    setValues((current) => ({ ...current, ...patch }))
  }

  function validate(): boolean {
    const nextErrors = validateSmtpForm(values)
    setErrors(nextErrors)
    return !Object.values(nextErrors).some(Boolean)
  }

  function handleSave() {
    if (!validate()) return
    saveMutation.mutate(buildSmtpInput(values, values.password.trim() === '' ? undefined : values.password))
  }

  function handleTest() {
    if (!validate()) return
    if (values.host.trim() === '' || values.port.trim() === '') {
      setErrors({ host: '测试连接前必须填写服务器地址。', port: '测试连接前必须填写端口。' })
      return
    }
    testMutation.mutate(buildSmtpInput(values, values.password.trim() === '' ? undefined : values.password))
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card aria-labelledby="admin-smtp-title">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id="admin-smtp-title" level={2}>
              SMTP 邮件服务
            </CardTitle>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            <Badge tone={settings.hasSecret ? 'success' : 'neutral'}>
              {settings.hasSecret ? '密码已保存' : '未保存密码'}
            </Badge>
          </div>
          <CardDescription>用于发送登录验证码与通知邮件。测试连接会真实连接外部服务，成功后才保存设置。</CardDescription>
        </CardHeader>
        <CardBody>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="服务器地址" required error={errors.host} hint="例如 smtp.example.com">
                <Input
                  value={values.host}
                  onChange={(event) => patchValues({ host: event.target.value })}
                  placeholder="smtp.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
              <Field label="端口" required error={errors.port} hint="STARTTLS 常用 587，隐式 TLS 常用 465。">
                <Input
                  value={values.port}
                  onChange={(event) => patchValues({ port: event.target.value })}
                  inputMode="numeric"
                  placeholder="587"
                  disabled={busy}
                />
              </Field>
            </div>

            <Field label="加密方式" error={errors.tlsMode}>
              <Select
                value={values.tlsMode}
                onChange={(event) => patchValues({ tlsMode: event.target.value as SmtpTlsMode })}
                disabled={busy}
              >
                {SMTP_TLS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="用户名" error={errors.username}>
                <Input
                  value={values.username}
                  onChange={(event) => patchValues({ username: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
              <Field
                label="密码"
                error={errors.password}
                hint={
                  settings.hasSecret
                    ? '已保存密码（永不回显）。留空保持不变；填写新值将覆盖旧密码。'
                    : '留空则保持未配置状态。'
                }
              >
                <Input
                  type="password"
                  value={values.password}
                  onChange={(event) => patchValues({ password: event.target.value })}
                  autoComplete="new-password"
                  placeholder={settings.hasSecret ? '已配置（留空保持不变）' : '填写 SMTP 密码'}
                  disabled={busy}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="发件人邮箱" error={errors.fromAddress} hint="验证码邮件的 From 地址。">
                <Input
                  value={values.fromAddress}
                  onChange={(event) => patchValues({ fromAddress: event.target.value })}
                  inputMode="email"
                  spellCheck={false}
                  placeholder="no-reply@example.com"
                  disabled={busy}
                />
              </Field>
              <Field label="发件人名称" error={errors.fromName}>
                <Input
                  value={values.fromName}
                  onChange={(event) => patchValues({ fromName: event.target.value })}
                  placeholder="MuseCanvas"
                  disabled={busy}
                />
              </Field>
            </div>

            {settings.secretFingerprint ? (
              <p className="font-mono text-xs text-muted-foreground">
                密码指纹：{settings.secretFingerprint} · 更新于 {formatDateTime(settings.updatedAt)} · #{settings.revision}
              </p>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">
                更新于 {formatDateTime(settings.updatedAt)} · #{settings.revision}
              </p>
            )}

            {values.tlsMode === 'none' ? (
              <Alert tone="warning" title="未启用传输加密">
                生产环境默认拒绝未加密的 SMTP；仅在明确允许（ALLOW_INSECURE_SMTP=true）时才能保存。
              </Alert>
            ) : null}
          </FieldGroup>
        </CardBody>
        <CardFooter>
          <Button variant="secondary" onClick={handleTest} loading={testMutation.isPending} disabled={busy && !testMutation.isPending}>
            测试连接
          </Button>
          <Button onClick={handleSave} loading={saveMutation.isPending} disabled={busy && !saveMutation.isPending}>
            保存邮件设置
          </Button>
        </CardFooter>
      </Card>

      <Card className="border border-danger-border bg-danger-soft">
        <CardHeader>
          <CardTitle level={2}>危险操作</CardTitle>
          <CardDescription>以下操作会立即改变实例行为，且无法撤销。</CardDescription>
        </CardHeader>
        <CardBody className="flex-row flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">清空已保存的 SMTP 密码</span>
            <span className="text-xs text-muted-foreground">清空后若未重新填写，验证码邮件将无法发送。</span>
          </div>
          <Button
            variant="danger-ghost"
            onClick={() => setConfirmClear(true)}
            disabled={!settings.hasSecret}
            icon={<Trash weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            清空密码
          </Button>
        </CardBody>
      </Card>

      <AdminSettingsConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="清空 SMTP 密码？"
        confirmLabel="清空密码"
        busy={clearMutation.isPending}
        onConfirm={() => clearMutation.mutate()}
      >
        <p>清空后保存的密码将被移除，SMTP 状态回到「已保存未验证」。如需继续发信，请重新填写密码并测试连接。</p>
        <p className="text-muted-foreground">该操作不可撤销。</p>
      </AdminSettingsConfirmDialog>
    </div>
  )
}
