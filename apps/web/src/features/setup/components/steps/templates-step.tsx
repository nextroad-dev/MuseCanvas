'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SetupConfigDto } from '@musecanvas/contracts'

import { Alert, Badge, Button, Field, Textarea } from '@/shared/components/ui'
import { formatDateTime } from '@/shared/lib/format'
import { clientApi } from '@/shared/services/client-api'
import { describeSetupError, isSetupSessionError } from '../../lib/setup-errors'
import { parseTemplateImportText } from '../../lib/setup-forms'
import { SetupStepShell } from '../setup-step-shell'

export interface TemplatesStepProps {
  config: SetupConfigDto
  /** 服务端 templates 段是否已完成导入。 */
  complete: boolean
  onDone: () => void | Promise<void>
  /** 可选步骤：跳过不写服务端，直接前进。 */
  onSkip: () => void
  onSessionLost: (message: string) => void
}

const SAMPLE_JSON = `{
  "templates": [
    {
      "name": "默认画面",
      "description": "通用图像提示词模板",
      "instruction": "{{input_prompt}}，{{size}}，高质量"
    }
  ]
}`

/**
 * 提示词模板（可选）。`GET /setup/config` 只返回内置模板索引的元信息（正文不返回），
 * 所以内置模板无法在本页直接导入；这里提供自备 JSON 导入，或直接跳过。
 *
 * 导入的 JSON 支持裸数组或 `{ templates: [...] }`，每条必须有 name 与 instruction
 * （变量白名单由服务端最终校验）。
 */
export function TemplatesStep({ config, complete, onDone, onSkip, onSessionLost }: TemplatesStepProps) {
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)

  const importTemplates = useMutation({
    mutationFn: (text: string) => {
      const parsed = parseTemplateImportText(text)
      if (!parsed.ok) throw new Error(parsed.error)
      return clientApi.setup.importPromptTemplates(parsed.entries)
    },
    onSuccess: async () => {
      setError(null)
      await onDone()
    },
    onError: (cause: unknown) => {
      if (isSetupSessionError(cause)) {
        onSessionLost(describeSetupError(cause, '初始化会话已失效。'))
        return
      }
      // 本地解析错误用 Error 携带；服务端错误仍按错误码翻译。
      setError(
        cause instanceof Error && !('code' in cause)
          ? cause.message
          : describeSetupError(cause, '导入模板失败，请稍后重试。'),
      )
    },
  })

  const active = config.templates.active
  const entries = config.templates.entries

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (importTemplates.isPending) return
    setError(null)
    importTemplates.mutate(json)
  }

  return (
    <SetupStepShell
      headingId="setup-templates-title"
      title="提示词模板"
      description="可选步骤：导入一组提示词模板并设为激活集。也可以完成安装后在后台“提示词模板”里管理。"
      status={<Badge tone={complete ? 'success' : 'neutral'}>{complete ? '已导入' : '可跳过'}</Badge>}
    >
      {active ? (
        <Alert tone="success" role="status" title={`已激活模板集：${active.name}`}>
          v{active.version} · {active.entryCount} 条 · 更新于{' '}
          <time dateTime={active.updatedAt} suppressHydrationWarning>
            {formatDateTime(active.updatedAt)}
          </time>
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="danger" role="alert" title="无法导入模板">
          {error}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2 rounded-control border border-border/70 bg-tonal p-4">
        <h2 className="text-sm font-medium text-foreground">
          服务端内置模板索引{entries.length > 0 ? `（${entries.length} 条）` : ''}
        </h2>
        {entries.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {entries.map((entry) => (
              <li key={`${entry.name}:${entry.path}`} className="flex flex-col gap-0.5 py-2">
                <span className="text-sm text-foreground">{entry.name}</span>
                <span className="text-xs text-muted-foreground">{entry.description}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            未在服务端检测到内置模板索引（可由管理员在后台导入模板包）。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          内置模板的正文只在服务端，本页不提供“一键导入”；请使用下方 JSON 导入自备模板，或跳过此步。
        </p>
      </div>

      <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
        <Field
          id="setup-templates-json"
          label="模板 JSON"
          hint="支持裸数组或 { templates: [...] }；每条包含 name、instruction，可选 description。变量只能使用 {{input_prompt}} 等白名单变量。"
        >
          <Textarea
            rows={8}
            value={json}
            disabled={importTemplates.isPending}
            placeholder={SAMPLE_JSON}
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(event) => {
              setJson(event.target.value)
              if (error) setError(null)
            }}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button type="submit" size="md" loading={importTemplates.isPending} disabled={!json.trim()}>
            导入并继续
          </Button>
          <Button type="button" variant="outline" size="md" disabled={importTemplates.isPending} onClick={onSkip}>
            跳过此步
          </Button>
        </div>
      </form>
    </SetupStepShell>
  )
}
