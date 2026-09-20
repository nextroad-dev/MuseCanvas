'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
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
import { Loader2, RefreshCw } from 'lucide-react'

const settingsQueryKey = ['admin', 'settings'] as const

interface Feedback {
  ok: boolean
  msg: string
}

const inputClass =
  'w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none'

const connectionStatusStyle: Record<SmtpConnectionStatus | StorageConnectionStatus, string> = {
  not_configured: 'bg-surface-subtle text-muted-foreground',
  configured: 'bg-warning-soft text-warning',
  verified: 'bg-success-soft text-success',
  error: 'bg-danger-soft text-danger',
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

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function SectionCard({
  title,
  description,
  status,
  children,
}: {
  title: string
  description: string
  status?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {status}
      </div>
      {children}
    </section>
  )
}

function ConnectionBadge({ status }: { status: SmtpConnectionStatus | StorageConnectionStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${connectionStatusStyle[status]}`}
    >
      {connectionStatusLabel[status]}
    </span>
  )
}

function SectionActions({
  saving,
  testing,
  onTest,
  testLabel,
}: {
  saving: boolean
  testing?: boolean
  onTest?: () => void
  testLabel?: string
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <button
        type="submit"
        disabled={saving}
        className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        保存
      </button>
      {onTest && (
        <button
          type="button"
          onClick={onTest}
          disabled={testing}
          className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:opacity-50"
        >
          {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {testLabel}
        </button>
      )}
    </div>
  )
}

function SiteSection({
  settings,
  onFeedback,
}: {
  settings: SiteSettingsDto
  onFeedback: (feedback: Feedback) => void
}) {
  const queryClient = useQueryClient()
  const [siteName, setSiteName] = useState(settings.siteName ?? '')
  const [siteUrl, setSiteUrl] = useState(settings.siteUrl ?? '')

  const save = useMutation({
    mutationFn: async () => {
      const body: SiteSettingsInput = {
        siteName: siteName.trim(),
        siteUrl: siteUrl.trim() || null,
      }
      if (!body.siteName) throw new Error('请输入站点名称')
      const res = await api(API_ENDPOINTS.setup.site, { method: 'POST', body })
      if (!res.success) throw new Error(res.error?.message || '保存站点配置失败')
      return res.data
    },
    onSuccess: () => {
      onFeedback({ ok: true, msg: '站点配置已保存' })
      queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => onFeedback({ ok: false, msg: err.message || '保存站点配置失败' }),
  })

  return (
    <SectionCard
      title="站点信息"
      description="用于邮件、OAuth 回调与分享链接中的实例公开地址。"
      status={<span className="text-[11px] text-muted-foreground">更新于 {settings.updatedAt.slice(0, 10)}</span>}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
        className="space-y-3"
      >
        <Field id="site-name" label="站点名称" hint="显示在标题、邮件与页面元信息中，最长 120 字符。">
          <input
            id="site-name"
            type="text"
            maxLength={120}
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field id="site-url" label="站点地址（可选）" hint="必须是 HTTPS 根地址，不能带路径、查询参数或认证信息；留空则回退到服务端环境变量推导的地址。">
          <input
            id="site-url"
            type="text"
            placeholder="https://musecanvas.example.com"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            className={inputClass}
          />
        </Field>
        <SectionActions saving={save.isPending} />
      </form>
    </SectionCard>
  )
}

function SmtpSection({
  settings,
  onFeedback,
}: {
  settings: SmtpSettingsDto
  onFeedback: (feedback: Feedback) => void
}) {
  const queryClient = useQueryClient()
  const [host, setHost] = useState(settings.host ?? '')
  const [port, setPort] = useState(settings.port === null ? '' : String(settings.port ?? ''))
  const [tlsMode, setTlsMode] = useState<SmtpTlsMode>(settings.tlsMode)
  const [username, setUsername] = useState(settings.username ?? '')
  const [password, setPassword] = useState('')
  const [fromAddress, setFromAddress] = useState(settings.fromAddress ?? '')
  const [fromName, setFromName] = useState(settings.fromName ?? '')

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
      const res = await api(API_ENDPOINTS.setup.smtp, { method: 'POST', body: toInput() })
      if (!res.success) throw new Error(res.error?.message || '保存 SMTP 设置失败')
      return res.data
    },
    onSuccess: () => {
      setPassword('')
      onFeedback({ ok: true, msg: 'SMTP 设置已保存，建议执行发信测试完成验证。' })
      queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => onFeedback({ ok: false, msg: err.message || '保存 SMTP 设置失败' }),
  })

  const test = useMutation({
    mutationFn: async () => {
      const res = await api<SetupSmtpTestResult>(API_ENDPOINTS.setup.smtpTest, {
        method: 'POST',
        body: toInput(),
      })
      if (!res.success || !res.data?.verified) throw new Error(res.error?.message || 'SMTP 连通性测试未通过')
      return res.data
    },
    onSuccess: () => {
      setPassword('')
      onFeedback({ ok: true, msg: 'SMTP 连通性测试通过，设置已保存并标记为已验证。' })
      queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => onFeedback({ ok: false, msg: err.message || 'SMTP 连通性测试未通过' }),
  })

  return (
    <SectionCard
      title="SMTP 邮件服务"
      description="用于发送登录验证码与通知邮件。"
      status={<ConnectionBadge status={settings.status} />}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id="smtp-host" label="发信服务器" hint="留空表示保持当前值不变。">
            <input
              id="smtp-host"
              type="text"
              placeholder="smtp.example.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="smtp-port" label="端口">
            <input
              id="smtp-port"
              type="number"
              min={1}
              max={65535}
              placeholder={settings.port === null ? '465' : String(settings.port)}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="smtp-tls" label="加密方式">
            <select
              id="smtp-tls"
              value={tlsMode}
              onChange={(e) => setTlsMode(e.target.value as SmtpTlsMode)}
              className={inputClass}
            >
              <option value="implicit_tls">隐式 TLS (465)</option>
              <option value="starttls">STARTTLS (587)</option>
              <option value="none">不加密</option>
            </select>
          </Field>
          <Field id="smtp-username" label="登录用户名">
            <input
              id="smtp-username"
              type="text"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            id="smtp-password"
            label="登录密码 / 授权码"
            hint={settings.hasSecret ? '已配置密钥，留空则保持不变。' : '密钥仅写入，不会回显。'}
          >
            <input
              id="smtp-password"
              type="password"
              autoComplete="new-password"
              placeholder={settings.hasSecret ? '••••••••' : '未设置'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="smtp-from-address" label="发件地址">
            <input
              id="smtp-from-address"
              type="email"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="smtp-from-name" label="发件人名称">
            <input
              id="smtp-from-name"
              type="text"
              maxLength={120}
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <SectionActions
          saving={save.isPending}
          testing={test.isPending}
          onTest={() => test.mutate()}
          testLabel="发信测试"
        />
      </form>
    </SectionCard>
  )
}

function StorageSection({
  settings,
  onFeedback,
}: {
  settings: StorageSettingsDto
  onFeedback: (feedback: Feedback) => void
}) {
  const queryClient = useQueryClient()
  const [endpoint, setEndpoint] = useState(settings.endpoint ?? '')
  const [publicEndpoint, setPublicEndpoint] = useState(settings.publicEndpoint ?? '')
  const [region, setRegion] = useState(settings.region)
  const [bucket, setBucket] = useState(settings.bucket ?? '')
  const [accessKeyId, setAccessKeyId] = useState(settings.accessKeyId ?? '')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [signedUrlTtlSeconds, setSignedUrlTtlSeconds] = useState(String(settings.signedUrlTtlSeconds))

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
      const res = await api(API_ENDPOINTS.setup.storage, { method: 'POST', body: toInput() })
      if (!res.success) throw new Error(res.error?.message || '保存对象存储设置失败')
      return res.data
    },
    onSuccess: () => {
      setSecretAccessKey('')
      onFeedback({ ok: true, msg: '对象存储设置已保存，建议执行连通性测试完成验证。' })
      queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => onFeedback({ ok: false, msg: err.message || '保存对象存储设置失败' }),
  })

  const test = useMutation({
    mutationFn: async () => {
      const res = await api<SetupStorageTestResult>(API_ENDPOINTS.setup.storageTest, {
        method: 'POST',
        body: toInput(),
      })
      if (!res.success || !res.data?.verified) throw new Error(res.error?.message || '对象存储连通性测试未通过')
      return res.data
    },
    onSuccess: () => {
      setSecretAccessKey('')
      onFeedback({ ok: true, msg: '对象存储连通性测试通过，设置已保存并标记为已验证。' })
      queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => onFeedback({ ok: false, msg: err.message || '对象存储连通性测试未通过' }),
  })

  return (
    <SectionCard
      title="对象存储"
      description="S3 兼容存储（含 MinIO / OSS / COS / R2），用于持久化生成的图像与视频资产。"
      status={<ConnectionBadge status={settings.status} />}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id="storage-endpoint" label="服务端点" hint="必须为 HTTP(S) 地址，不能带查询参数。">
            <input
              id="storage-endpoint"
              type="text"
              placeholder="https://minio.internal:9000"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="storage-public-endpoint" label="公网访问端点（可选）">
            <input
              id="storage-public-endpoint"
              type="text"
              placeholder="https://cdn.example.com"
              value={publicEndpoint}
              onChange={(e) => setPublicEndpoint(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="storage-region" label="区域" hint="仅小写字母、数字与连字符，最长 32 字符。">
            <input
              id="storage-region"
              type="text"
              maxLength={32}
              placeholder="us-east-1"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="storage-bucket" label="存储桶" hint="3-63 字符，仅小写字母、数字、连字符与点。">
            <input
              id="storage-bucket"
              type="text"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="storage-access-key" label="Access Key ID">
            <input
              id="storage-access-key"
              type="text"
              autoComplete="off"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            id="storage-secret-key"
            label="Secret Access Key"
            hint={settings.hasSecret ? '已配置密钥，留空则保持不变。' : '密钥仅写入，不会回显。'}
          >
            <input
              id="storage-secret-key"
              type="password"
              autoComplete="new-password"
              placeholder={settings.hasSecret ? '••••••••' : '未设置'}
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="storage-ttl" label="签名 URL 有效期（秒）" hint="允许范围 60 - 3600。">
            <input
              id="storage-ttl"
              type="number"
              min={60}
              max={3600}
              value={signedUrlTtlSeconds}
              onChange={(e) => setSignedUrlTtlSeconds(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <SectionActions
          saving={save.isPending}
          testing={test.isPending}
          onTest={() => test.mutate()}
          testLabel="连通性测试"
        />
      </form>
    </SectionCard>
  )
}

const runtimeFields: Array<{
  key: keyof RuntimeSettingsInput
  id: string
  label: string
  min: number
  max: number
  unit: string
}> = [
  { key: 'uploadTtlSeconds', id: 'rt-upload-ttl', label: '上传暂存有效期', min: 300, max: 604800, unit: '秒' },
  { key: 'signedUrlTtlSeconds', id: 'rt-signed-ttl', label: '签名 URL 有效期', min: 60, max: 3600, unit: '秒' },
  { key: 'maxImageBytes', id: 'rt-max-image', label: '单图大小上限', min: 1, max: 100000000, unit: '字节' },
  { key: 'maxTotalBytes', id: 'rt-max-total', label: '单次上传总大小上限', min: 1, max: 200000000, unit: '字节' },
  { key: 'maxInputs', id: 'rt-max-inputs', label: '单次生成参考图上限', min: 1, max: 32, unit: '张' },
  { key: 'providerTimeoutMs', id: 'rt-provider-timeout', label: '上游请求超时', min: 1, max: 3600000, unit: '毫秒' },
  { key: 'maxOutputBytes', id: 'rt-max-output', label: '生成结果大小上限', min: 1, max: 100000000, unit: '字节' },
  { key: 'jobLeaseMs', id: 'rt-job-lease', label: '任务租约时长', min: 1, max: 3600000, unit: '毫秒' },
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
  settings,
  onFeedback,
}: {
  settings: RuntimeSettingsDto
  onFeedback: (feedback: Feedback) => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<RuntimeDraft>(() => toRuntimeDraft(settings))

  function toValues(): Record<keyof RuntimeSettingsInput, number> {
    // Every field is always submitted: the server only cross-checks the keys present
    // in the request, so a partial submit could store a total cap below the
    // single-image cap that stays in the row. Blank inputs fall back to the stored value.
    const values = {} as Record<keyof RuntimeSettingsInput, number>
    for (const { key } of runtimeFields) {
      const raw = draft[key].trim()
      values[key] = raw === '' ? settings[key] : Number(raw)
    }
    return values
  }

  const save = useMutation({
    mutationFn: async () => {
      const values = toValues()
      if (values.maxTotalBytes < values.maxImageBytes) {
        throw new Error('总大小上限不能小于单图大小上限')
      }
      const res = await api(API_ENDPOINTS.setup.runtime, { method: 'POST', body: values })
      if (!res.success) throw new Error(res.error?.message || '保存运行时限制失败')
      return res.data
    },
    onSuccess: () => {
      onFeedback({ ok: true, msg: '运行时限制已保存，Worker 将在缓存刷新后生效。' })
      queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
    onError: (err: Error) => onFeedback({ ok: false, msg: err.message || '保存运行时限制失败' }),
  })

  return (
    <SectionCard
      title="运行时限制"
      description="上传、生成任务与上游调用的护栏参数，留空的字段保持原值。"
      status={<span className="text-[11px] text-muted-foreground">更新于 {settings.updatedAt.slice(0, 10)}</span>}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {runtimeFields.map(({ key, id, label, min, max, unit }) => (
            <Field key={key} id={id} label={`${label}（${unit}）`}>
              <input
                id={id}
                type="number"
                min={min}
                max={max}
                value={draft[key]}
                onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                className={inputClass}
              />
            </Field>
          ))}
        </div>
        <SectionActions saving={save.isPending} />
      </form>
    </SectionCard>
  )
}

export function AdminSettingsView() {
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const {
    data: config,
    isLoading,
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

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">系统配置</h1>
          <p className="text-sm text-muted-foreground">实例初始化后的站点、邮件、存储与运行时参数维护入口。</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      <div role="status" aria-live="polite" className="empty:hidden">
        {feedback && (
          <div
            className={`rounded-[var(--radius-control)] border p-3 text-xs ${
              feedback.ok
                ? 'border-border bg-surface-subtle text-foreground'
                : 'border-danger-soft bg-danger-soft/20 text-danger'
            }`}
          >
            {feedback.msg}
          </div>
        )}
      </div>

      {isLoading && (
        <div className="p-8 text-center text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      )}

      {isError && (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
          {error instanceof Error ? error.message : '读取系统配置失败'}
        </div>
      )}

      {config && (
        <div className="space-y-4">
          <SiteSection
            key={`site-${config.site.revision}`}
            settings={config.site}
            onFeedback={setFeedback}
          />
          <SmtpSection
            key={`smtp-${config.smtp.revision}`}
            settings={config.smtp}
            onFeedback={setFeedback}
          />
          <StorageSection
            key={`storage-${config.storage.revision}`}
            settings={config.storage}
            onFeedback={setFeedback}
          />
          <RuntimeSection
            key={`runtime-${config.runtime.revision}`}
            settings={config.runtime}
            onFeedback={setFeedback}
          />
        </div>
      )}
    </div>
  )
}
