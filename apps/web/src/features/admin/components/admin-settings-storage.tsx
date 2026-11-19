'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { HardDrivesIcon as HardDrives, TrashIcon as Trash } from '@phosphor-icons/react'
import type { StorageDriverKind, StorageSettingsDto, StorageSettingsInput } from '@musecanvas/contracts'
import { Alert } from '@/shared/components/ui/alert'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Field, FieldGroup } from '@/shared/components/ui/field'
import { Input } from '@/shared/components/ui/input'
import { Select } from '@/shared/components/ui/select'
import { useToast } from '@/shared/components/ui/toast'
import { controlSquare, iconSize } from '@/shared/components/ui/size'
import { cn } from '@/shared/lib/cn'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import {
  STORAGE_DRIVER_OPTIONS,
  validateStorageForm,
} from '@/features/admin/lib/admin-settings-forms'
import type { StorageFormValues } from '@/features/admin/lib/admin-settings-forms'
import { clientApi } from '@/shared/services/client-api'
import { AdminSettingsConfirmDialog } from './admin-settings-confirm-dialog'

const STATUS_LABEL: Record<StorageSettingsDto['status'], { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  not_configured: { label: '未配置', tone: 'neutral' },
  configured: { label: '已保存未验证', tone: 'info' },
  verified: { label: '连接已验证', tone: 'success' },
  error: { label: '读取密钥失败', tone: 'danger' },
}

function storageDraft(settings: StorageSettingsDto): StorageFormValues {
  return {
    driver: settings.driver,
    localRoot: settings.localRoot ?? '',
    endpoint: settings.endpoint ?? '',
    publicEndpoint: settings.publicEndpoint ?? '',
    region: settings.region ?? '',
    bucket: settings.bucket ?? '',
    accessKeyId: settings.accessKeyId ?? '',
    secretAccessKey: '',
    signedUrlTtlSeconds: String(settings.signedUrlTtlSeconds),
  }
}

function buildStorageInput(values: StorageFormValues, secretAccessKey?: string): StorageSettingsInput {
  const input: StorageSettingsInput = {
    driver: values.driver,
    signedUrlTtlSeconds: values.signedUrlTtlSeconds.trim() === '' ? null : Number(values.signedUrlTtlSeconds),
    ...(values.driver === 'local'
      ? { localRoot: values.localRoot.trim() === '' ? null : values.localRoot.trim() }
      : {
          endpoint: values.endpoint.trim() === '' ? null : values.endpoint.trim(),
          publicEndpoint: values.publicEndpoint.trim() === '' ? null : values.publicEndpoint.trim(),
          region: values.region.trim() === '' ? null : values.region.trim(),
          bucket: values.bucket.trim() === '' ? null : values.bucket.trim(),
          accessKeyId: values.accessKeyId.trim() === '' ? null : values.accessKeyId.trim(),
        }),
  }
  if (secretAccessKey !== undefined) input.secretAccessKey = secretAccessKey
  return input
}

export interface AdminSettingsStorageProps {
  settings: StorageSettingsDto
  onSaved: (settings: StorageSettingsDto) => void
}

/** 对象存储分区：S3 兼容 / 本地磁盘切换、测试连接（成功即保存）、危险区清空密钥。 */
export function AdminSettingsStorage({ settings, onSaved }: AdminSettingsStorageProps) {
  const { toast } = useToast()
  const [values, setValues] = useState<StorageFormValues>(() => storageDraft(settings))
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [confirmClear, setConfirmClear] = useState(false)
  const clearedRevision = useRef<number | null>(null)
  const status = STATUS_LABEL[settings.status]

  useEffect(() => {
    // Clearing the saved secret is not a form save: keep unrelated local drafts.
    if (clearedRevision.current === settings.revision) {
      clearedRevision.current = null
      return
    }
    clearedRevision.current = null
    setValues(storageDraft(settings))
    setErrors({})
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: (input: StorageSettingsInput) => clientApi.setup.updateStorage(input),
    onSuccess: (saved) => {
      onSaved(saved)
      setValues((current) => ({ ...current, secretAccessKey: '' }))
      toast.success('对象存储设置已保存')
    },
    onError: (error) => toast.error('保存对象存储设置失败', adminErrorMessage(error)),
  })

  const testMutation = useMutation({
    mutationFn: (input: StorageSettingsInput) => clientApi.setup.testStorage(input),
    onSuccess: (result) => {
      onSaved(result.settings)
      setValues((current) => ({ ...current, secretAccessKey: '' }))
      toast.success('对象存储连接验证成功', '验证通过后设置已自动保存。')
    },
    onError: (error) => toast.error('对象存储连接测试失败', adminErrorMessage(error)),
  })

  const clearMutation = useMutation({
    mutationFn: (input: StorageSettingsInput) => clientApi.setup.updateStorage(input),
    onSuccess: (saved) => {
      clearedRevision.current = saved.revision
      onSaved(saved)
      setConfirmClear(false)
      setValues((current) => ({ ...current, secretAccessKey: '' }))
      toast.success('已清空保存的 Secret Access Key')
    },
    onError: (error) => toast.error('清空存储密钥失败', adminErrorMessage(error)),
  })

  const busy = saveMutation.isPending || testMutation.isPending || clearMutation.isPending

  function patchValues(patch: Partial<StorageFormValues>) {
    setValues((current) => ({ ...current, ...patch }))
  }

  function validate(): boolean {
    const nextErrors = validateStorageForm(values)
    setErrors(nextErrors)
    return !Object.values(nextErrors).some(Boolean)
  }

  function handleSave() {
    if (!validate()) return
    saveMutation.mutate(
      buildStorageInput(values, values.secretAccessKey.trim() === '' ? undefined : values.secretAccessKey),
    )
  }

  function handleTest() {
    if (!validate()) return
    if (values.driver === 'local') {
      toast.info('本地存储无需连接测试', '保存后请确认容器内目录存在且有读写权限。')
      return
    }
    const requiredErrors: Record<string, string | undefined> = {}
    if (values.endpoint.trim() === '') requiredErrors.endpoint = '测试连接前必须填写服务端点。'
    if (values.bucket.trim() === '') requiredErrors.bucket = '测试连接前必须填写存储桶。'
    if (Object.values(requiredErrors).some(Boolean)) {
      setErrors((current) => ({ ...current, ...requiredErrors }))
      return
    }
    testMutation.mutate(
      buildStorageInput(values, values.secretAccessKey.trim() === '' ? undefined : values.secretAccessKey),
    )
  }

  function handleClearSecret() {
    clearMutation.mutate({ secretAccessKey: '' })
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card aria-labelledby="admin-storage-title">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent',
                controlSquare.md,
              )}
            >
              <HardDrives weight="duotone" aria-hidden="true" className={iconSize.md} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle id="admin-storage-title" level={2}>
                  对象存储
                </CardTitle>
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
                <Badge tone={values.driver === 's3' ? 'neutral' : 'info'}>
                  {values.driver === 's3' ? 'S3 兼容' : '本地磁盘'}
                </Badge>
                <Badge tone={settings.hasSecret ? 'success' : 'neutral'}>
                  {settings.hasSecret ? '密钥已保存' : '未保存密钥'}
                </Badge>
              </div>
              <CardDescription>
                S3 兼容存储（MinIO / OSS / COS / R2）或本地磁盘目录，用于持久化生成的图像与视频资产。测试连接会真实读写测试对象。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {settings.status === 'error' ? (
            <Alert tone="danger" title="已保存的存储密钥无法解密">
              请重新填写 Secret Access Key 并保存；在此之前新上传会失败。
            </Alert>
          ) : null}

          <FieldGroup>
            <Field label="存储驱动" hint="切换到本地磁盘时，历史对象仍保留在原存储中，需要自行迁移。">
              <Select
                value={values.driver}
                onChange={(event) => patchValues({ driver: event.target.value as StorageDriverKind })}
                disabled={busy}
              >
                {STORAGE_DRIVER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            {values.driver === 'local' ? (
              <Field
                label="本地存储目录"
                required
                hint="容器内绝对路径（以 / 开头，不含 ..），需挂载持久卷，例如 /data/uploads。"
                error={errors.localRoot}
              >
                <Input
                  value={values.localRoot}
                  onChange={(event) => patchValues({ localRoot: event.target.value })}
                  placeholder="/data/uploads"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="服务端点"
                    required
                    hint="API 访问地址，例如 https://minio.example.com，不要带桶名。"
                    error={errors.endpoint}
                  >
                    <Input
                      value={values.endpoint}
                      onChange={(event) => patchValues({ endpoint: event.target.value })}
                      inputMode="url"
                      spellCheck={false}
                      placeholder="https://minio.example.com"
                      disabled={busy}
                    />
                  </Field>
                  <Field label="公网端点" hint="可选：浏览器可访问的地址，用于签名 URL 与直传。" error={errors.publicEndpoint}>
                    <Input
                      value={values.publicEndpoint}
                      onChange={(event) => patchValues({ publicEndpoint: event.target.value })}
                      inputMode="url"
                      spellCheck={false}
                      placeholder="https://cdn.example.com"
                      disabled={busy}
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="区域" error={errors.region} hint="例如 us-east-1；MinIO 可留空。">
                    <Input
                      value={values.region}
                      onChange={(event) => patchValues({ region: event.target.value })}
                      spellCheck={false}
                      placeholder="us-east-1"
                      disabled={busy}
                    />
                  </Field>
                  <Field label="存储桶" required error={errors.bucket}>
                    <Input
                      value={values.bucket}
                      onChange={(event) => patchValues({ bucket: event.target.value })}
                      spellCheck={false}
                      placeholder="musecanvas"
                      disabled={busy}
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Access Key ID" error={errors.accessKeyId}>
                    <Input
                      value={values.accessKeyId}
                      onChange={(event) => patchValues({ accessKeyId: event.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                    />
                  </Field>
                  <Field
                    label="Secret Access Key"
                    error={errors.secretAccessKey}
                    hint={
                      settings.hasSecret
                        ? '已保存密钥（永不回显）。留空保持不变；填写新值将覆盖旧密钥。'
                        : '尚未保存密钥。'
                    }
                  >
                    <Input
                      type="password"
                      value={values.secretAccessKey}
                      onChange={(event) => patchValues({ secretAccessKey: event.target.value })}
                      autoComplete="new-password"
                      placeholder={settings.hasSecret ? '已配置（留空保持不变）' : '填写 Secret Access Key'}
                      disabled={busy}
                    />
                  </Field>
                </div>

                <Field label="签名 URL 有效期（秒）" hint="60 - 3600 秒。" error={errors.signedUrlTtlSeconds}>
                  <Input
                    value={values.signedUrlTtlSeconds}
                    onChange={(event) => patchValues({ signedUrlTtlSeconds: event.target.value })}
                    inputMode="numeric"
                    disabled={busy}
                  />
                </Field>
              </>
            )}

            <p className="font-mono text-xs tabular-nums text-muted-foreground">
              {settings.secretFingerprint ? `密钥指纹：${settings.secretFingerprint} · ` : ''}
              更新于 {formatDateTime(settings.updatedAt)} · #{settings.revision}
            </p>
          </FieldGroup>
        </CardBody>
        <CardFooter>
          <Button
            variant="secondary"
            onClick={handleTest}
            loading={testMutation.isPending}
            disabled={values.driver === 'local' || (busy && !testMutation.isPending)}
            leadingIcon={<HardDrives weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            测试连接
          </Button>
          <Button onClick={handleSave} loading={saveMutation.isPending} disabled={busy && !saveMutation.isPending}>
            保存存储设置
          </Button>
        </CardFooter>
      </Card>

      <Card className="border-danger-border bg-danger-soft">
        <CardHeader>
          <CardTitle level={2}>危险操作</CardTitle>
          <CardDescription>以下操作会立即改变实例行为，且无法撤销。</CardDescription>
        </CardHeader>
        <CardBody className="flex-row flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">清空已保存的 Secret Access Key</span>
            <span className="text-xs text-muted-foreground">清空后对象存储将无法访问，新的上传与读取会失败。</span>
          </div>
          <Button
            variant="danger-ghost"
            onClick={() => setConfirmClear(true)}
            disabled={!settings.hasSecret || busy}
            leadingIcon={<Trash weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            清空密钥
          </Button>
        </CardBody>
      </Card>

      <AdminSettingsConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="清空对象存储密钥？"
        confirmLabel="清空密钥"
        busy={clearMutation.isPending}
        onConfirm={handleClearSecret}
      >
        <p>清空后保存的 Secret Access Key 将被移除；已有对象不会删除，但新的上传、读取与签名 URL 都会失败。</p>
        <p className="text-muted-foreground">该操作不可撤销，请确认已在别处备份密钥。</p>
      </AdminSettingsConfirmDialog>
    </div>
  )
}
