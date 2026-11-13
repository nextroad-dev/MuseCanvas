'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SetupConfigDto } from '@musecanvas/contracts'
import { clientApi } from '@/shared/services/client-api'
import { Alert, Badge, Button, Field, Input } from '@/shared/components/ui'
import { describeSetupError, isSetupSessionError } from '../../lib/setup-errors'
import {
  RUNTIME_FIELD_SPECS,
  runtimeDraftFromDto,
  toRuntimeInput,
  validateRuntimeDraft,
} from '../../lib/setup-forms'
import type { RuntimeDraft } from '../../lib/setup-forms'
import { SetupStepShell } from '../setup-step-shell'

export interface RuntimeStepProps {
  config: SetupConfigDto
  /** 服务端 runtime 段是否已完成（保存即完成）。 */
  complete: boolean
  onDone: () => void | Promise<void>
  onSessionLost: (message: string) => void
}

/** 运行时限制：8 个数值，保存即生效（服务端会写 onboarding runtime 段）。 */
export function RuntimeStep({ config, complete, onDone, onSessionLost }: RuntimeStepProps) {
  const [draft, setDraft] = useState<RuntimeDraft>(() => runtimeDraftFromDto(config.runtime))
  const [errors, setErrors] = useState<ReturnType<typeof validateRuntimeDraft>>({})
  const [notice, setNotice] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => clientApi.setup.updateRuntime(toRuntimeInput(draft)),
    onSuccess: async () => {
      setNotice(null)
      await onDone()
    },
    onError: (error: unknown) => {
      if (isSetupSessionError(error)) {
        onSessionLost(describeSetupError(error, '初始化会话已失效。'))
        return
      }
      setNotice(describeSetupError(error, '保存运行时限制失败，请稍后重试。'))
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (save.isPending) return
    const next = validateRuntimeDraft(draft)
    setErrors(next)
    setNotice(null)
    if (Object.keys(next).length > 0) return
    save.mutate()
  }

  return (
    <SetupStepShell
      headingId="setup-runtime-title"
      title="运行时限制"
      description="上传、签名链接、任务与供应商超时的上限。保存后由 API 与 Worker 的运行时配置缓存生效。"
      status={<Badge tone={complete ? 'success' : 'neutral'}>{complete ? '已保存' : '可调整'}</Badge>}
    >
      {notice ? (
        <Alert tone="danger" role="alert" title="无法保存运行时限制">
          {notice}
        </Alert>
      ) : null}

      <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {RUNTIME_FIELD_SPECS.map((spec) => (
            <Field
              key={spec.key}
              id={`setup-runtime-${spec.key}`}
              label={`${spec.label}（${spec.unit}）`}
              required
              error={errors[spec.key]}
              hint={spec.hint}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={spec.min}
                max={spec.max}
                value={draft[spec.key]}
                disabled={save.isPending}
                className="font-mono tabular-nums"
                onChange={(event) => {
                  setDraft((previous) => ({ ...previous, [spec.key]: event.target.value }))
                  setErrors((previous) => ({ ...previous, [spec.key]: undefined }))
                  if (notice) setNotice(null)
                }}
              />
            </Field>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={save.isPending}>
            保存并继续
          </Button>
          <span className="text-xs text-muted-foreground">不确定时保留默认值即可，之后可在后台设置中调整。</span>
        </div>
      </form>
    </SetupStepShell>
  )
}
