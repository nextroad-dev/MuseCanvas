'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SetupConfigDto, StorageDriverKind } from '@musecanvas/contracts'

import { Alert, Badge, Button, Field, Input, SegmentedControl } from '@/shared/components/ui'
import { clientApi } from '@/shared/services/client-api'
import { describeSetupError, isSetupSessionError } from '../../lib/setup-errors'
import {
  STORAGE_DRIVER_OPTIONS,
  connectionStatusLabel,
  storageDraftFromDto,
  toStorageInput,
  validateStorageDraft,
} from '../../lib/setup-forms'
import type { StorageDraft, StorageFieldErrors } from '../../lib/setup-forms'
import { SetupStepShell } from '../setup-step-shell'

export interface StorageStepProps {
  config: SetupConfigDto
  /** 服务端 storage 段是否已完成（= 连接测试已通过）。 */
  complete: boolean
  onDone: () => void | Promise<void>
  onSessionLost: (message: string) => void
}

/**
 * 对象存储：S3 兼容或本地磁盘。连接测试会在存储里写一个测试对象，成功后才保存并
 * 标记为已验证；失败不落库。密钥只写不回显，留空表示沿用已保存的密钥。
 */
export function StorageStep({ config, complete, onDone, onSessionLost }: StorageStepProps) {
  const [draft, setDraft] = useState<StorageDraft>(() => storageDraftFromDto(config.storage))
  const [errors, setErrors] = useState<StorageFieldErrors>({})
  const [notice, setNotice] = useState<string | null>(null)

  const verify = useMutation({
    mutationFn: () =>
      clientApi.setup.testStorage(toStorageInput(draft, { hasStoredSecret: config.storage.hasSecret })),
    onSuccess: async () => {
      setNotice(null)
      await onDone()
    },
    onError: (error: unknown) => {
      if (isSetupSessionError(error)) {
        onSessionLost(describeSetupError(error, '初始化会话已失效。'))
        return
      }
      setNotice(describeSetupError(error, '对象存储连接验证未通过，设置未被保存。'))
    },
  })

  const status = config.storage.status

  function patch(patchValue: Partial<StorageDraft>) {
    setDraft((previous) => ({ ...previous, ...patchValue }))
    if ('driver' in patchValue) {
      setErrors({})
    } else {
      setErrors((previous) => {
        const next = { ...previous }
        for (const key of Object.keys(patchValue) as Array<keyof StorageDraft>) {
          if (key in next) {
            delete next[key as keyof StorageFieldErrors]
          }
        }
        return next
      })
    }
    setNotice(null)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (verify.isPending) return
    const next = validateStorageDraft(draft, { hasStoredSecret: config.storage.hasSecret })
    setErrors(next)
    setNotice(null)
    if (Object.keys(next).length > 0) return
    verify.mutate()
  }

  return (
    <SetupStepShell
      headingId="setup-storage-title"
      title="对象存储"
      description="生成的作品保存位置。S3 兼容存储（MinIO / AWS S3 / R2）或本地磁盘目录。"
      status={
        <Badge tone={complete ? 'success' : status === 'error' ? 'danger' : 'neutral'}>
          {complete ? '已验证' : connectionStatusLabel(status)}
        </Badge>
      }
    >
      {notice ? (
        <Alert tone="danger" role="alert" title="对象存储验证未通过">
          {notice}
        </Alert>
      ) : null}

      {complete ? (
        <Alert tone="success" role="status" title="对象存储已验证">
          当前配置已通过连接测试。切换驱动或修改参数后需要重新验证。
        </Alert>
      ) : null}

      <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">存储驱动</span>
          <SegmentedControl
            items={STORAGE_DRIVER_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              title: option.hint,
            }))}
            value={draft.driver}
            onChange={(driver: StorageDriverKind) => patch({ driver })}
            label="存储驱动"
            fullWidth
          />
          <p className="text-xs text-muted-foreground">
            {STORAGE_DRIVER_OPTIONS.find((option) => option.value === draft.driver)?.hint}
          </p>
        </div>

        {draft.driver === 'local' ? (
          <Field
            id="setup-storage-local-root"
            label="本地存储目录"
            required
            error={errors.localRoot}
            hint="绝对路径，例如 /data/musecanvas/storage；API 与 Worker 必须挂载同一目录。"
          >
            <Input
              size="md"
              value={draft.localRoot}
              disabled={verify.isPending}
              placeholder="/data/musecanvas/storage"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => patch({ localRoot: event.target.value })}
            />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field
                id="setup-storage-endpoint"
                label="服务端点"
                required
                error={errors.endpoint}
                hint="例如 http://minio:9000 或 https://s3.us-east-1.amazonaws.com。"
              >
                <Input
                  type="url"
                  size="md"
                  value={draft.endpoint}
                  disabled={verify.isPending}
                  placeholder="https://s3.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => patch({ endpoint: event.target.value })}
                />
              </Field>

              <Field
                id="setup-storage-public-endpoint"
                label="公网端点"
                error={errors.publicEndpoint}
                hint="可选：浏览器访问媒体的地址；留空时复用服务端点。"
              >
                <Input
                  type="url"
                  size="md"
                  value={draft.publicEndpoint}
                  disabled={verify.isPending}
                  placeholder="https://files.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => patch({ publicEndpoint: event.target.value })}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field id="setup-storage-region" label="区域" required error={errors.region}>
                <Input
                  size="md"
                  value={draft.region}
                  disabled={verify.isPending}
                  placeholder="us-east-1"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => patch({ region: event.target.value })}
                />
              </Field>

              <Field id="setup-storage-bucket" label="存储桶" required error={errors.bucket}>
                <Input
                  size="md"
                  value={draft.bucket}
                  disabled={verify.isPending}
                  placeholder="musecanvas"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => patch({ bucket: event.target.value })}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field id="setup-storage-access-key" label="访问密钥 ID" required error={errors.accessKeyId}>
                <Input
                  size="md"
                  value={draft.accessKeyId}
                  disabled={verify.isPending}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => patch({ accessKeyId: event.target.value })}
                />
              </Field>

              <Field
                id="setup-storage-secret"
                label="访问密钥"
                required={!config.storage.hasSecret}
                error={errors.secretAccessKey}
                hint={config.storage.hasSecret ? '已保存密钥（只写不回显）；留空沿用。' : '只写不回显。'}
              >
                <Input
                  type="password"
                  size="md"
                  value={draft.secretAccessKey}
                  disabled={verify.isPending}
                  autoComplete="new-password"
                  placeholder={config.storage.hasSecret ? '••••••••（留空沿用）' : ''}
                  onChange={(event) => patch({ secretAccessKey: event.target.value })}
                />
              </Field>
            </div>
          </>
        )}

        <Field
          id="setup-storage-ttl"
          label="签名链接有效期"
          error={errors.signedUrlTtlSeconds}
          hint="60–3600 秒，默认 900 秒；媒体 URL 过期后重新读取即可。"
        >
          <Input
            type="number"
            size="md"
            inputMode="numeric"
            min={60}
            max={3600}
            value={draft.signedUrlTtlSeconds}
            disabled={verify.isPending}
            className="font-mono tabular-nums"
            onChange={(event) => patch({ signedUrlTtlSeconds: event.target.value })}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="md" loading={verify.isPending}>
            测试连接并保存
          </Button>
          <span className="text-xs text-muted-foreground">测试会写入并删除一个测试对象；失败时不保存任何改动。</span>
        </div>
      </form>
    </SetupStepShell>
  )
}
