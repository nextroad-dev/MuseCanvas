'use client'

import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowCounterClockwiseIcon as Reset } from '@phosphor-icons/react'
import type { RuntimeSettingsDto } from '@musecanvas/contracts'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Field, FieldGroup } from '@/shared/components/ui/field'
import { Input } from '@/shared/components/ui/input'
import { useToast } from '@/shared/components/ui/toast'
import { iconSize } from '@/shared/components/ui/size'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import {
  RUNTIME_FIELD_META,
  runtimeDraftDefaults,
  runtimeDraftFromDto,
  runtimeDraftToInput,
  runtimeRangeLabel,
  validateRuntimeForm,
} from '@/features/admin/lib/admin-settings-forms'
import type { RuntimeInputDraft } from '@/features/admin/lib/admin-settings-forms'
import { clientApi } from '@/shared/services/client-api'

const UNIT_LABEL: Record<string, string> = {
  seconds: '秒',
  milliseconds: '秒',
  bytes: 'MB',
  count: '张',
}

export interface AdminSettingsRuntimeProps {
  settings: RuntimeSettingsDto
  onSaved: (settings: RuntimeSettingsDto) => void
}

/** 运行时限制分区：上传/资产/上游调用护栏；所有值按输入单位展示（MB / 秒 / 张）。 */
export function AdminSettingsRuntime({ settings, onSaved }: AdminSettingsRuntimeProps) {
  const { toast } = useToast()
  const [draft, setDraft] = useState<RuntimeInputDraft>(() => runtimeDraftFromDto(settings))
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    setDraft(runtimeDraftFromDto(settings))
    setErrors({})
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: (input: ReturnType<typeof runtimeDraftToInput>) => clientApi.setup.updateRuntime(input),
    onSuccess: (saved) => {
      onSaved(saved)
      setErrors({})
      toast.success('运行时限制已保存')
    },
    onError: (error) => toast.error('保存运行时限制失败', adminErrorMessage(error)),
  })

  function handleSave() {
    const nextErrors = validateRuntimeForm(draft)
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    saveMutation.mutate(runtimeDraftToInput(draft))
  }

  function handleReset() {
    setDraft(runtimeDraftDefaults())
    setErrors({})
    toast.info('已恢复默认值', '点击「保存运行时限制」后才会写入。')
  }

  return (
    <Card aria-labelledby="admin-runtime-title">
      <CardHeader>
        <CardTitle id="admin-runtime-title" level={2}>
          运行时限制
        </CardTitle>
        <CardDescription>
          上传、生成任务与上游调用的护栏参数。留空无效；保存后立即生效于新请求，进行中的任务不受影响。
        </CardDescription>
      </CardHeader>
      <CardBody>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            {RUNTIME_FIELD_META.map((meta) => (
              <Field
                key={meta.key}
                label={`${meta.label}（${UNIT_LABEL[meta.unit]}）`}
                hint={`${meta.hint}；输入范围 ${runtimeRangeLabel(meta)}`}
                error={errors[meta.key]}
              >
                <Input
                  value={draft[meta.key]}
                  onChange={(event) => setDraft((current) => ({ ...current, [meta.key]: event.target.value }))}
                  inputMode={meta.unit === 'count' ? 'numeric' : 'decimal'}
                  spellCheck={false}
                  disabled={saveMutation.isPending}
                />
              </Field>
            ))}
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            更新于 {formatDateTime(settings.updatedAt)} · #{settings.revision}
          </p>
        </FieldGroup>
      </CardBody>
      <CardFooter>
        <Button
          variant="ghost"
          onClick={handleReset}
          disabled={saveMutation.isPending}
          icon={<Reset weight="bold" aria-hidden="true" className={iconSize.sm} />}
        >
          恢复默认值
        </Button>
        <Button onClick={handleSave} loading={saveMutation.isPending}>
          保存运行时限制
        </Button>
      </CardFooter>
    </Card>
  )
}
