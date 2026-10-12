'use client'

import { cn } from '@/shared/lib/cn'
import { adminTouchTargetsSquare, adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import { useCallback, useEffect, useState } from 'react'
import { useMutation,
  useQuery,
  useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import { requireAdminData } from '../lib/admin-query'
import { adminSettingsDraftChanged, hasNewerAdminSettingsRevision, requireVerifiedAdminSettings } from '../lib/admin-settings-state'
import { AdminCanvasAgentSettings } from './admin-canvas-agent-settings'
import type {
  RuntimeSettingsDto,
  RuntimeSettingsInput,
  SetupConfigResponse,
  SetupSmtpTestResult,
  SetupStorageTestResult,
  SiteSettingsDto,
  SiteSettingsInput,
  SmtpConnectionStatus,
  SmtpSettingsDto,
  SmtpSettingsInput,
  SmtpTlsMode,
  StorageConnectionStatus,
  StorageSettingsDto,
  StorageSettingsInput,
  } from '@/shared/types'
import {
  Alert,
  Badge,
  Button,
  CardDescription,
  CardTitle,
  Dialog,
  FieldGroup,
  FormField,
  Input,
  PageHeader,
  Select,
  SkeletonText,
  SkeletonTile,
  Tabs,
  iconSize,
} from '@/shared/components/ui'
import type { BadgeTone } from '@/shared/components/ui'
import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react'

const settingsQueryKey = ['admin', 'settings'] as const

interface Feedback {
  ok: boolean
  msg: string
}

interface SectionState { dirty: boolean; busy: boolean }
type SectionStateReporter = (section: SectionId, state: SectionState) => void

function SettingsSectionFeedback({ feedback, newerRevision, dirty, busy, onReload }: {
  feedback: Feedback | null; newerRevision: boolean; dirty: boolean; busy: boolean; onReload: () => void
}) {
  const [confirmReload, setConfirmReload] = useState(false)
  return <>
    {feedback && <Alert tone={feedback.ok ? 'success' : 'danger'} role={feedback.ok ? 'status' : 'alert'}>{feedback.msg}</Alert>}
    {newerRevision && <Alert tone="info" title="服务端配置已更新" action={
      <Button variant="secondary" disabled={busy} onClick={() => { if (dirty) setConfirmReload(true); else onReload() }}>重新载入本分区</Button>
    }>当前草稿与已载入基线均保留。重新载入才会采用服务端新版本，并清空本分区的敏感输入。</Alert>}
    <Dialog open={confirmReload} onClose={() => setConfirmReload(false)} title="放弃草稿并重新载入？" size="narrow" panelClassName={cn('max-h-[90dvh]', adminTouchTargetsSquare)} footer={<>
      <Button variant="ghost" disabled={busy} onClick={() => setConfirmReload(false)}>保留草稿</Button>
      <Button variant="danger" disabled={busy} onClick={() => { onReload(); setConfirmReload(false) }}>放弃草稿并载入</Button>
    </>}><p className="text-sm">本分区尚有未保存内容。重新载入会替换此草稿，密钥输入也会清空；其它分区不受影响。</p></Dialog>
  </>
}

/** Persistent section panels preserve drafts and write-only secret inputs across tab changes. */
type SectionId = 'site' | 'smtp' | 'storage' | 'runtime' | 'canvasAgent'

const connectionStatusTone: Record<SmtpConnectionStatus | StorageConnectionStatus, BadgeTone> = {
  not_configured: 'neutral',
  configured: 'warning',
  verified: 'success',
  error: 'danger',
}

const connectionStatusLabel: Record<SmtpConnectionStatus | StorageConnectionStatus, string> = {
  not_configured: '未配置',
  configured: '已保存待验证',
  verified: '已验证',
  error: '连接异常',
}

// Empty inputs are omitted so the server keeps the stored value instead of clearing it.
function keepIfEmpty(raw: string): string | undefined {
  return raw.trim() === '' ? undefined : raw.trim()
}

function keepIfEmptyNumber(raw: string): number | undefined {
  return raw.trim() === '' ? undefined : Number(raw)
}

function ConnectionBadge({ status }: { status: SmtpConnectionStatus | StorageConnectionStatus }) {
  return <Badge tone={connectionStatusTone[status]}>{connectionStatusLabel[status]}</Badge>
}

/** Section header: title + description on the left, status metadata on the right. */
function SectionHeader({
  title,
  description,
  status,
}: {
  title: string
  description: string
  status?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border pb-6">
      <div className="flex min-w-0 flex-col gap-1">
        <CardTitle level={2}>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
      {status ? <div className="flex shrink-0 items-center gap-2">{status}</div> : null}
    </div>
  )
}

/**
 * 危险操作区 (components.md 场景模式 → 设置页): its own block at the bottom of the
 * segment — a 4px danger bar on the `danger-soft` surface. It sits between cards,
 * never inside one, so no divider rule is needed.
 */
function DangerZone({ description, children }: { description: string; children: React.ReactNode }) {
  return (
    <section
      aria-label="危险操作"
      className="flex flex-col gap-4 rounded-card border border-danger-border bg-danger-soft p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-module text-danger">危险操作</h3>
        <p className="max-w-reading text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  )
}

/**
 * Sticky save bar (设置页 footer): 取消 ghost + 保存 primary. The buttons submit the
 * segment's form through its `id`, so each section keeps its own mutation.
 */
function SaveBar({
  formId,
  dirty,
  saving,
  busy,
  onCancel,
}: {
  formId: string
  dirty: boolean
  saving: boolean
  busy: boolean
  onCancel: () => void
}) {
  return (
    <div className="sticky bottom-0 z-sticky flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface p-4 shadow-floating">
      <p role="status" className="text-sm text-muted-foreground">{busy ? '本分区操作中，表单已锁定。' : dirty ? '有未保存的更改。' : '当前没有可提交的更改。'}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" className="min-h-[var(--control-lg)] md:min-h-[var(--control-md)]" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" className="min-h-[var(--control-lg)] md:min-h-[var(--control-md)]" form={formId} loading={saving} disabled={busy || !dirty}>
          保存
        </Button>
      </div>
    </div>
  )
}

const FORM_ID = {
  site: 'admin-settings-site-form',
  smtp: 'admin-settings-smtp-form',
  storage: 'admin-settings-storage-form',
  runtime: 'admin-settings-runtime-form',
} as const

const updatedAtStatus = (updatedAt: string) => (
  <p className="text-xs text-muted-foreground">更新于 {updatedAt.slice(0, 10)}</p>
)

function SiteSection({
  settings: latestSettings,
  onStateChange,
}: {
  settings: SiteSettingsDto
  onStateChange: SectionStateReporter
}) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState(latestSettings)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [siteName, setSiteName] = useState(settings.siteName ?? '')
  const [siteUrl, setSiteUrl] = useState(settings.siteUrl ?? '')

  const dirty = siteName.trim() !== (settings.siteName ?? '') || (siteUrl.trim() || null) !== (settings.siteUrl ?? null)

  const save = useMutation({
    mutationFn: async () => {
      const body: SiteSettingsInput = {
        siteName: siteName.trim(),
        siteUrl: siteUrl.trim() || null,
      }
      if (!body.siteName) throw new Error('请输入站点名称')
      const res = await api<SiteSettingsDto>(API_ENDPOINTS.setup.site, { method: 'POST', body })
      if (!res.success) throw new Error(res.error?.message || '保存站点配置失败')
      return requireAdminData(res, '保存响应缺少配置数据')
    },
    onSuccess: async (data) => {
      loadSettings(data)
      setFeedback({ ok: true, msg: '站点配置已保存' })
      await queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || '保存站点配置失败' }),
  })

  function reset() {
    setSiteName(settings.siteName ?? '')
    setSiteUrl(settings.siteUrl ?? '')
  }

  function loadSettings(next: SiteSettingsDto) {
    setSettings(next)
    setFeedback(null)
    setSiteName(next.siteName ?? '')
    setSiteUrl(next.siteUrl ?? '')
  }

  const busy = save.isPending
  useEffect(() => { onStateChange('site', { dirty, busy }) }, [dirty, busy, onStateChange])

  return (
    <>
      <SettingsSectionFeedback feedback={feedback} newerRevision={hasNewerAdminSettingsRevision(settings, latestSettings)} dirty={dirty} busy={busy} onReload={() => loadSettings(latestSettings)} />
      <section className="@container/fields flex min-w-0 flex-col gap-6">
        <SectionHeader
          title="站点信息"
          description="用于邮件、OAuth 回调与分享链接中的实例公开地址。"
          status={updatedAtStatus(settings.updatedAt)}
        />
        <form
          id={FORM_ID.site}
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && dirty) save.mutate()
          }}
        >
          <fieldset disabled={busy} className="min-w-0">
            <FieldGroup>
              <FormField label="站点名称" required hint="显示在标题、邮件与页面元信息中，最长 120 字符。">
                <Input type="text" maxLength={120} value={siteName} onChange={(e) => setSiteName(e.target.value)} />
              </FormField>
              <FormField
                label="站点地址（可选）"
                hint="必须是 HTTPS 根地址，不能带路径、查询参数或认证信息；留空则回退到服务端环境变量推导的地址。"
              >
                <Input
                  type="text"
                  placeholder="https://musecanvas.example.com"
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                />
              </FormField>
            </FieldGroup>
          </fieldset>
        </form>
      </section>
      <SaveBar formId={FORM_ID.site} dirty={dirty} saving={save.isPending} busy={busy} onCancel={reset} />
    </>
  )
}

function SmtpSection({
  settings: latestSettings,
  onStateChange,
}: {
  settings: SmtpSettingsDto
  onStateChange: SectionStateReporter
}) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState(latestSettings)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [host, setHost] = useState(settings.host ?? '')
  const [port, setPort] = useState(settings.port === null ? '' : String(settings.port ?? ''))
  const [tlsMode, setTlsMode] = useState<SmtpTlsMode>(settings.tlsMode)
  const [username, setUsername] = useState(settings.username ?? '')
  const [password, setPassword] = useState('')
  const [fromAddress, setFromAddress] = useState(settings.fromAddress ?? '')
  const [fromName, setFromName] = useState(settings.fromName ?? '')

  const portBaseline = settings.port === null ? '' : String(settings.port ?? '')
  const dirty = adminSettingsDraftChanged(toInput(), settings)

  // The password field is write-only: an untouched input is omitted so the stored
  // secret survives, while sending an empty string would wipe it.
  function toInput(): SmtpSettingsInput {
    return {
      host: keepIfEmpty(host),
      port: keepIfEmptyNumber(port),
      tlsMode: tlsMode === settings.tlsMode ? undefined : tlsMode,
      username: keepIfEmpty(username),
      password: password.trim() || undefined,
      fromAddress: keepIfEmpty(fromAddress),
      fromName: keepIfEmpty(fromName),
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const res = await api<SmtpSettingsDto>(API_ENDPOINTS.setup.smtp, { method: 'POST', body: toInput() })
      if (!res.success) throw new Error(res.error?.message || '保存 SMTP 设置失败')
      return requireAdminData(res, '保存响应缺少配置数据')
    },
    onSuccess: async (data) => {
      loadSettings(data)
      setFeedback({ ok: true, msg: 'SMTP 设置已保存，建议验证连接；保存本身不代表可以投递邮件。' })
      await queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || '保存 SMTP 设置失败' }),
  })

  const test = useMutation({
    mutationFn: async () => {
      const res = await api<SetupSmtpTestResult>(API_ENDPOINTS.setup.smtpTest, {
        method: 'POST',
        body: toInput(),
      })
      return requireVerifiedAdminSettings(res, 'SMTP 连接验证未通过或响应缺少设置数据')
    },
    onSuccess: async (data) => {
      loadSettings(data)
      setFeedback({ ok: true, msg: '当前草稿的 SMTP 连接验证通过，设置已保存；此测试不发送邮件，也不保证邮件投递。' })
      await queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || 'SMTP 连通性测试未通过' }),
  })

  function reset() {
    setHost(settings.host ?? '')
    setPort(portBaseline)
    setTlsMode(settings.tlsMode)
    setUsername(settings.username ?? '')
    setPassword('')
    setFromAddress(settings.fromAddress ?? '')
    setFromName(settings.fromName ?? '')
  }

  function loadSettings(next: SmtpSettingsDto) {
    setSettings(next)
    setFeedback(null)
    setHost(next.host ?? '')
    setPort(next.port === null ? '' : String(next.port ?? ''))
    setTlsMode(next.tlsMode)
    setUsername(next.username ?? '')
    setPassword('')
    setFromAddress(next.fromAddress ?? '')
    setFromName(next.fromName ?? '')
  }

  const busy = save.isPending || test.isPending
  useEffect(() => { onStateChange('smtp', { dirty, busy }) }, [dirty, busy, onStateChange])

  return (
    <>
      <SettingsSectionFeedback feedback={feedback} newerRevision={hasNewerAdminSettingsRevision(settings, latestSettings)} dirty={dirty} busy={busy} onReload={() => loadSettings(latestSettings)} />
      <section className="@container/fields flex min-w-0 flex-col gap-6">
        <SectionHeader
          title="SMTP 邮件服务"
          description="用于发送登录验证码与通知邮件。"
          status={<ConnectionBadge status={settings.status} />}
        />
        <form
          id={FORM_ID.smtp}
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && dirty) save.mutate()
          }}
        >
          <fieldset disabled={busy} className="min-w-0">
            <div className="grid min-w-0 gap-6 @min-[560px]/fields:grid-cols-2">
              <FormField label="发信服务器" hint="留空表示保持当前值不变。">
                <Input type="text" placeholder="smtp.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
              </FormField>
              <FormField label="端口">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  placeholder={settings.port === null ? '465' : String(settings.port)}
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </FormField>
              <FormField label="加密方式">
                <Select value={tlsMode} onChange={(e) => setTlsMode(e.target.value as SmtpTlsMode)}>
                  <option value="implicit_tls">隐式 TLS（465）</option>
                  <option value="starttls">STARTTLS（587）</option>
                  <option value="none">不加密</option>
                </Select>
              </FormField>
              <FormField label="登录用户名">
                <Input
                  type="text"
                  autoComplete="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </FormField>
              <FormField
                label="登录密码 / 授权码"
                hint={settings.hasSecret ? '已配置密钥，留空则保持不变。' : '密钥仅写入，不会回显。'}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.hasSecret ? '••••••••' : '未设置'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </FormField>
              <FormField label="发件地址">
                <Input type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} />
              </FormField>
              <FormField label="发件人名称">
                <Input type="text" maxLength={120} value={fromName} onChange={(e) => setFromName(e.target.value)} />
              </FormField>
            </div>
          </fieldset>
        </form>
      </section>

      <DangerZone description="验证当前草稿的 SMTP 连接，不发送邮件；连接成功后才保存设置，连接失败不保存。测试会真实连接外部服务；成功保存后登录密钥可能被覆盖，旧值无法取回。">
        <Button variant="secondary" loading={test.isPending} disabled={busy} onClick={() => { if (!busy) test.mutate() }}>
          验证 SMTP 连接
        </Button>
      </DangerZone>

      <SaveBar formId={FORM_ID.smtp} dirty={dirty} saving={save.isPending} busy={busy} onCancel={reset} />
    </>
  )
}

function StorageSection({
  settings: latestSettings,
  onStateChange,
}: {
  settings: StorageSettingsDto
  onStateChange: SectionStateReporter
}) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState(latestSettings)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [endpoint, setEndpoint] = useState(settings.endpoint ?? '')
  const [publicEndpoint, setPublicEndpoint] = useState(settings.publicEndpoint ?? '')
  const [region, setRegion] = useState(settings.region)
  const [bucket, setBucket] = useState(settings.bucket ?? '')
  const [accessKeyId, setAccessKeyId] = useState(settings.accessKeyId ?? '')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [signedUrlTtlSeconds, setSignedUrlTtlSeconds] = useState(String(settings.signedUrlTtlSeconds))

  const dirty = adminSettingsDraftChanged(toInput(), settings)

  function toInput(): StorageSettingsInput {
    return {
      endpoint: keepIfEmpty(endpoint),
      publicEndpoint: keepIfEmpty(publicEndpoint),
      region: keepIfEmpty(region),
      bucket: keepIfEmpty(bucket),
      accessKeyId: keepIfEmpty(accessKeyId),
      secretAccessKey: secretAccessKey.trim() || undefined,
      signedUrlTtlSeconds: keepIfEmptyNumber(signedUrlTtlSeconds),
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const res = await api<StorageSettingsDto>(API_ENDPOINTS.setup.storage, { method: 'POST', body: toInput() })
      if (!res.success) throw new Error(res.error?.message || '保存对象存储设置失败')
      return requireAdminData(res, '保存响应缺少配置数据')
    },
    onSuccess: async (data) => {
      loadSettings(data)
      setFeedback({ ok: true, msg: '对象存储设置已保存，建议执行连通性测试完成验证。' })
      await queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || '保存对象存储设置失败' }),
  })

  const test = useMutation({
    mutationFn: async () => {
      const res = await api<SetupStorageTestResult>(API_ENDPOINTS.setup.storageTest, {
        method: 'POST',
        body: toInput(),
      })
      return requireVerifiedAdminSettings(res, '对象存储连通性测试未通过或响应缺少设置数据')
    },
    onSuccess: async (data) => {
      loadSettings(data)
      setFeedback({ ok: true, msg: '当前草稿的对象存储连通性测试通过，设置已保存并标记为已验证。' })
      await queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || '对象存储连通性测试未通过' }),
  })

  function reset() {
    setEndpoint(settings.endpoint ?? '')
    setPublicEndpoint(settings.publicEndpoint ?? '')
    setRegion(settings.region)
    setBucket(settings.bucket ?? '')
    setAccessKeyId(settings.accessKeyId ?? '')
    setSecretAccessKey('')
    setSignedUrlTtlSeconds(String(settings.signedUrlTtlSeconds))
  }

  function loadSettings(next: StorageSettingsDto) {
    setSettings(next)
    setFeedback(null)
    setEndpoint(next.endpoint ?? '')
    setPublicEndpoint(next.publicEndpoint ?? '')
    setRegion(next.region)
    setBucket(next.bucket ?? '')
    setAccessKeyId(next.accessKeyId ?? '')
    setSecretAccessKey('')
    setSignedUrlTtlSeconds(String(next.signedUrlTtlSeconds))
  }

  const busy = save.isPending || test.isPending
  useEffect(() => { onStateChange('storage', { dirty, busy }) }, [dirty, busy, onStateChange])

  return (
    <>
      <SettingsSectionFeedback feedback={feedback} newerRevision={hasNewerAdminSettingsRevision(settings, latestSettings)} dirty={dirty} busy={busy} onReload={() => loadSettings(latestSettings)} />
      <section className="@container/fields flex min-w-0 flex-col gap-6">
        <SectionHeader
          title="对象存储"
          description="S3 兼容存储（含 MinIO / OSS / COS / R2），用于持久化生成的图像与视频资产。"
          status={<ConnectionBadge status={settings.status} />}
        />
        <form
          id={FORM_ID.storage}
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && dirty) save.mutate()
          }}
        >
          <fieldset disabled={busy} className="min-w-0">
            <div className="grid min-w-0 gap-6 @min-[560px]/fields:grid-cols-2">
              <FormField label="服务端点" hint="必须为 HTTP(S) 地址，不能带查询参数。">
                <Input
                  type="text"
                  placeholder="https://minio.internal:9000"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </FormField>
              <FormField label="公网访问端点（可选）">
                <Input
                  type="text"
                  placeholder="https://cdn.example.com"
                  value={publicEndpoint}
                  onChange={(e) => setPublicEndpoint(e.target.value)}
                />
              </FormField>
              <FormField label="区域" hint="仅小写字母、数字与连字符，最长 32 字符。">
                <Input
                  type="text"
                  maxLength={32}
                  placeholder="us-east-1"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
              </FormField>
              <FormField label="存储桶" hint="3-63 字符，仅小写字母、数字、连字符与点。">
                <Input type="text" value={bucket} onChange={(e) => setBucket(e.target.value)} />
              </FormField>
              <FormField label="Access Key ID">
                <Input
                  type="text"
                  autoComplete="off"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                />
              </FormField>
              <FormField
                label="Secret Access Key"
                hint={settings.hasSecret ? '已配置密钥，留空则保持不变。' : '密钥仅写入，不会回显。'}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.hasSecret ? '••••••••' : '未设置'}
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                />
              </FormField>
              <FormField label="签名 URL 有效期（秒）" hint="允许范围 60 - 3600。">
                <Input
                  type="number"
                  min={60}
                  max={3600}
                  value={signedUrlTtlSeconds}
                  onChange={(e) => setSignedUrlTtlSeconds(e.target.value)}
                />
              </FormField>
            </div>
          </fieldset>
        </form>
      </section>

      <DangerZone description="测试当前草稿，会真实读写存储桶中的测试对象；测试成功后才保存设置，失败不保存。成功保存后 Secret Access Key 可能被覆盖，旧值无法取回。">
        <Button variant="secondary" loading={test.isPending} disabled={busy} onClick={() => { if (!busy) test.mutate() }}>
          运行连通性测试
        </Button>
      </DangerZone>

      <SaveBar formId={FORM_ID.storage} dirty={dirty} saving={save.isPending} busy={busy} onCancel={reset} />
    </>
  )
}

const runtimeFields: Array<{
  key: keyof RuntimeSettingsInput
  label: string
  min: number
  max: number
}> = [
  { key: 'uploadTtlSeconds', label: '上传暂存有效期（秒）', min: 300, max: 604800 },
  { key: 'signedUrlTtlSeconds', label: '签名 URL 有效期（秒）', min: 60, max: 3600 },
  { key: 'maxImageBytes', label: '单图大小上限（字节）', min: 1, max: 100000000 },
  { key: 'maxTotalBytes', label: '单次上传总大小上限（字节）', min: 1, max: 200000000 },
  { key: 'maxInputs', label: '单次生成参考图上限（张）', min: 1, max: 32 },
  { key: 'providerTimeoutMs', label: '上游请求超时（毫秒）', min: 1, max: 3600000 },
  { key: 'maxOutputBytes', label: '生成结果大小上限（字节）', min: 1, max: 100000000 },
  { key: 'jobLeaseMs', label: '任务租约时长（毫秒）', min: 1, max: 3600000 },
]

type RuntimeDraft = Record<keyof RuntimeSettingsInput, string>

function toRuntimeDraft(settings: RuntimeSettingsDto): RuntimeDraft {
  return {
    uploadTtlSeconds: String(settings.uploadTtlSeconds),
    signedUrlTtlSeconds: String(settings.signedUrlTtlSeconds),
    maxImageBytes: String(settings.maxImageBytes),
    maxTotalBytes: String(settings.maxTotalBytes),
    maxInputs: String(settings.maxInputs),
    providerTimeoutMs: String(settings.providerTimeoutMs),
    maxOutputBytes: String(settings.maxOutputBytes),
    jobLeaseMs: String(settings.jobLeaseMs),
  }
}

function RuntimeSection({
  settings: latestSettings,
  onStateChange,
}: {
  settings: RuntimeSettingsDto
  onStateChange: SectionStateReporter
}) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState(latestSettings)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [draft, setDraft] = useState<RuntimeDraft>(() => toRuntimeDraft(settings))

  const dirty = adminSettingsDraftChanged(toValues(), settings)

  function resolve(key: keyof RuntimeSettingsInput) {
    const raw = draft[key].trim()
    return raw === '' ? settings[key] : Number(raw)
  }

  // The same cross-check the mutation runs, surfaced on the field that caused it.
  const totalBelowImage = resolve('maxTotalBytes') < resolve('maxImageBytes')

  function toValues(): Record<keyof RuntimeSettingsInput, number> {
    // Every field is always submitted: the server only cross-checks the keys present
    // in the request, so a partial submit could store a total cap below the
    // single-image cap that stays in the row. Blank inputs fall back to the stored value.
    const values = {} as Record<keyof RuntimeSettingsInput, number>
    for (const { key } of runtimeFields) {
      values[key] = resolve(key)
    }
    return values
  }

  const save = useMutation({
    mutationFn: async () => {
      const values = toValues()
      if (values.maxTotalBytes < values.maxImageBytes) {
        throw new Error('总大小上限不能小于单图大小上限')
      }
      const res = await api<RuntimeSettingsDto>(API_ENDPOINTS.setup.runtime, { method: 'POST', body: values })
      if (!res.success) throw new Error(res.error?.message || '保存运行时限制失败')
      return requireAdminData(res, '保存响应缺少配置数据')
    },
    onSuccess: async (data) => {
      loadSettings(data)
      setFeedback({ ok: true, msg: '运行时限制已保存，Worker 将在缓存刷新后生效。' })
      await queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || '保存运行时限制失败' }),
  })

  function loadSettings(next: RuntimeSettingsDto) {
    setSettings(next)
    setFeedback(null)
    setDraft(toRuntimeDraft(next))
  }

  const busy = save.isPending
  useEffect(() => { onStateChange('runtime', { dirty, busy }) }, [dirty, busy, onStateChange])

  return (
    <>
      <SettingsSectionFeedback feedback={feedback} newerRevision={hasNewerAdminSettingsRevision(settings, latestSettings)} dirty={dirty} busy={busy} onReload={() => loadSettings(latestSettings)} />
      <section className="@container/fields flex min-w-0 flex-col gap-6">
        <SectionHeader
          title="运行时限制"
          description="上传、生成任务与上游调用的护栏参数，留空的字段保持原值。"
          status={updatedAtStatus(settings.updatedAt)}
        />
        <form
          id={FORM_ID.runtime}
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && dirty) save.mutate()
          }}
        >
          <fieldset disabled={busy} className="min-w-0">
            <div className="grid min-w-0 gap-6 @min-[560px]/fields:grid-cols-2">
              {runtimeFields.map(({ key, label, min, max }) => (
                <FormField
                  key={key}
                  label={label}
                  error={
                    key === 'maxTotalBytes' && totalBelowImage ? '总大小上限不能小于单图大小上限。' : undefined
                  }
                >
                  <Input
                    type="number"
                    min={min}
                    max={max}
                    value={draft[key]}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                </FormField>
              ))}
            </div>
          </fieldset>
        </form>
      </section>

      <SaveBar
        formId={FORM_ID.runtime}
        dirty={dirty}
        saving={save.isPending}
        busy={busy}
        onCancel={() => setDraft(toRuntimeDraft(settings))}
      />
    </>
  )
}

function SettingsSkeleton() {
  return <div className="flex min-w-0 flex-col gap-4" aria-hidden="true">
    <div className="flex max-w-full gap-2 overflow-hidden">{[0, 1, 2, 3, 4].map((index) => <SkeletonTile key={index} className="aspect-auto h-10 w-28 shrink-0 rounded-control" />)}</div>
    <div className="w-full max-w-form">
      <div className="@container/fields flex min-w-0 flex-col gap-6">
        <SkeletonText width="12rem" /><SkeletonText lines={2} />
        <div className="flex flex-col gap-6">{[0, 1].map((index) => <div key={index} className="flex flex-col gap-2"><SkeletonText width="8rem" /><SkeletonTile className="aspect-auto h-10 w-full rounded-control" /></div>)}</div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface p-4 shadow-floating"><SkeletonText width="10rem" /><SkeletonTile className="aspect-auto h-10 w-32 rounded-control" /></div>
    </div>
  </div>
}

export function AdminSettingsView() {
  const [sectionStates, setSectionStates] = useState<Partial<Record<SectionId, SectionState>>>({})
  const [refreshConfirm, setRefreshConfirm] = useState(false)
  const reportSectionState = useCallback<SectionStateReporter>((section, state) => {
    setSectionStates((previous) => ({ ...previous, [section]: state }))
  }, [])
  const reportCanvasAgentState = useCallback((state: SectionState) => {
    reportSectionState('canvasAgent', state)
  }, [reportSectionState])
  const anyDirty = Object.values(sectionStates).some((state) => state?.dirty)
  const anyBusy = Object.values(sectionStates).some((state) => state?.busy)
  const [active, setActive] = useState<SectionId>('site')

  const {
    data: config,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: settingsQueryKey,
    queryFn: async () => {
      const res = await api<SetupConfigResponse>(API_ENDPOINTS.setup.config)
      if (!res.success || !res.data) throw new Error(res.error?.message || '读取系统配置失败')
      return res.data
    },
  })

  function requestRefresh() {
    if (anyBusy) return
    if (anyDirty) setRefreshConfirm(true)
    else void refetch()
  }

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="系统配置"
        description="实例初始化后的站点、邮件、存储与运行时参数维护入口。"
        actions={
          <Button
            variant="secondary"
            onClick={requestRefresh}
            loading={isFetching}
            disabled={anyBusy}
            icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            刷新
          </Button>
        }
      />

      <Dialog open={refreshConfirm} onClose={() => setRefreshConfirm(false)} title="有未保存草稿，仍要刷新？" size="narrow" panelClassName={cn('max-h-[90dvh]', adminTouchTargetsSquare)} footer={<>
        <Button variant="ghost" onClick={() => setRefreshConfirm(false)}>取消刷新</Button>
        <Button variant="secondary" disabled={anyBusy || isFetching} onClick={() => { setRefreshConfirm(false); void refetch() }}>获取服务端最新配置</Button>
      </>}>
        <p className="text-sm">刷新仅获取服务端状态，不会覆盖任何分区草稿。检测到新版本后，可在对应分区确认放弃草稿并重新载入。</p>
      </Dialog>

      {isLoading ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">正在加载系统配置</span>
          <SettingsSkeleton />
        </div>
      ) : null}

      {isError ? (
        <Alert
          tone="danger"
          role="alert"
          title={config ? '系统配置刷新失败' : '无法加载系统配置'}
          action={
            <Button variant="secondary" size="sm" loading={isFetching} disabled={anyBusy} onClick={requestRefresh}>
              刷新重试
            </Button>
          }
        >
          {error instanceof Error ? error.message : '读取系统配置失败'}。{config ? '已保留载入的配置和当前草稿。' : '请稍后重试。'}
        </Alert>
      ) : null}

      {config ? (
        <Tabs
          variant="underline" value={active} onValueChange={(id) => setActive(id as SectionId)} lazy={false}
          aria-label="设置分组" className="w-full min-w-0"
          listClassName="max-w-full overflow-x-auto"
          tabs={[
            { id: 'site', label: <>站点信息 {sectionStates.site?.dirty && <Badge tone="warning">未保存</Badge>}</>, content: <div className="flex w-full max-w-form min-w-0 flex-col gap-6"><SiteSection settings={config.site} onStateChange={reportSectionState} /></div> },
            { id: 'smtp', label: <>SMTP 邮件 {sectionStates.smtp?.dirty && <Badge tone="warning">未保存</Badge>}</>, content: <div className="flex w-full max-w-form min-w-0 flex-col gap-6"><SmtpSection settings={config.smtp} onStateChange={reportSectionState} /></div> },
            { id: 'storage', label: <>对象存储 {sectionStates.storage?.dirty && <Badge tone="warning">未保存</Badge>}</>, content: <div className="flex w-full max-w-form min-w-0 flex-col gap-6"><StorageSection settings={config.storage} onStateChange={reportSectionState} /></div> },
            { id: 'runtime', label: <>运行时限制 {sectionStates.runtime?.dirty && <Badge tone="warning">未保存</Badge>}</>, content: <div className="flex w-full max-w-form min-w-0 flex-col gap-6"><RuntimeSection settings={config.runtime} onStateChange={reportSectionState} /></div> },
            { id: 'canvasAgent', label: <>Canvas Agent {sectionStates.canvasAgent?.dirty && <Badge tone="warning">未保存</Badge>}</>, content: <div className="flex w-full max-w-form min-w-0 flex-col gap-6"><AdminCanvasAgentSettings onStateChange={reportCanvasAgentState} /></div> },
          ]}
        />
      ) : null}
    </div>
  )
}
