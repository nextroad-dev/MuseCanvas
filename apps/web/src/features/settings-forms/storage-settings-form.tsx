'use client'

import { FormField, Input, Radio, RadioGroup } from '@/shared/components/ui'
import type { StorageDriverKind, StorageSettingsDto } from '@musecanvas/contracts'
import type { StorageDraft } from './settings-form-state'

export type StorageDraftErrors = Partial<Record<keyof StorageDraft, string>>

export interface StorageSettingsFormProps {
  formId: string
  /** Stored settings: supplies placeholders and the "secret already set" hint. */
  baseline: StorageSettingsDto
  draft: StorageDraft
  onDraftChange: (patch: Partial<StorageDraft>) => void
  onSubmit: () => void
  disabled?: boolean
  errors?: StorageDraftErrors
  noValidate?: boolean
}

/**
 * Storage driver switch plus the fields of the selected driver. Fields of the
 * other driver stay in the owner's draft, so switching back restores them.
 */
export function StorageSettingsForm({
  formId,
  baseline,
  draft,
  onDraftChange,
  onSubmit,
  disabled = false,
  errors,
  noValidate,
}: StorageSettingsFormProps) {
  const driverLabelId = `${formId}-driver-label`
  const isLocal = draft.driver === 'local'

  return (
    <form
      id={formId}
      noValidate={noValidate}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <fieldset disabled={disabled} className="min-w-0">
        <div className="grid min-w-0 gap-6 @min-[560px]/fields:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2 @min-[560px]/fields:col-span-2">
            <span id={driverLabelId} className="text-sm font-medium text-foreground">
              存储驱动
            </span>
            <RadioGroup
              aria-labelledby={driverLabelId}
              orientation="horizontal"
              value={draft.driver}
              onValueChange={(value) => onDraftChange({ driver: value as StorageDriverKind })}
            >
              <Radio value="s3" label="S3 兼容对象存储" />
              <Radio value="local" label="本地磁盘" />
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              切换驱动后请重新执行连通性测试，测试通过后才会标记为已验证。
            </p>
          </div>

          {isLocal ? (
            <FormField
              label="本地目录（绝对路径）"
              className="@min-[560px]/fields:col-span-2"
              required
              hint="API 与 Worker 必须挂载同一卷到此路径，否则 Worker 写入的文件 API 无法读取。"
              error={errors?.localRoot}
            >
              <Input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="/data/musecanvas/assets"
                value={draft.localRoot}
                onChange={(e) => onDraftChange({ localRoot: e.target.value })}
              />
            </FormField>
          ) : (
            <>
              <FormField label="服务端点" hint="必须为 HTTP(S) 地址，不能带查询参数。" error={errors?.endpoint}>
                <Input
                  type="text"
                  placeholder="https://minio.internal:9000"
                  value={draft.endpoint}
                  onChange={(e) => onDraftChange({ endpoint: e.target.value })}
                />
              </FormField>
              <FormField label="公网访问端点（可选）">
                <Input
                  type="text"
                  placeholder="https://cdn.example.com"
                  value={draft.publicEndpoint}
                  onChange={(e) => onDraftChange({ publicEndpoint: e.target.value })}
                />
              </FormField>
              <FormField label="区域" hint="仅小写字母、数字与连字符，最长 32 字符。" error={errors?.region}>
                <Input
                  type="text"
                  maxLength={32}
                  placeholder="us-east-1"
                  value={draft.region}
                  onChange={(e) => onDraftChange({ region: e.target.value })}
                />
              </FormField>
              <FormField label="存储桶" hint="3-63 字符，仅小写字母、数字、连字符与点。" error={errors?.bucket}>
                <Input type="text" value={draft.bucket} onChange={(e) => onDraftChange({ bucket: e.target.value })} />
              </FormField>
              <FormField label="Access Key ID">
                <Input
                  type="text"
                  autoComplete="off"
                  value={draft.accessKeyId}
                  onChange={(e) => onDraftChange({ accessKeyId: e.target.value })}
                />
              </FormField>
              <FormField
                label="Secret Access Key"
                hint={baseline.hasSecret ? '已配置密钥，留空则保持不变。' : '密钥仅写入，不会回显。'}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={baseline.hasSecret ? '••••••••' : '未设置'}
                  value={draft.secretAccessKey}
                  onChange={(e) => onDraftChange({ secretAccessKey: e.target.value })}
                />
              </FormField>
              <FormField label="签名 URL 有效期（秒）" hint="允许范围 60 - 3600。" error={errors?.signedUrlTtlSeconds}>
                <Input
                  type="number"
                  min={60}
                  max={3600}
                  value={draft.signedUrlTtlSeconds}
                  onChange={(e) => onDraftChange({ signedUrlTtlSeconds: e.target.value })}
                />
              </FormField>
            </>
          )}
        </div>
      </fieldset>
    </form>
  )
}
