'use client'

import { useEffect, useState } from 'react'
import type { PromptTemplateEntryDto, RenderPromptTemplateResult } from '@musecanvas/contracts'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
} from '@/shared/components/ui'
import { usePreviewPromptTemplate } from '@/shared/hooks/useAdmin'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import {
  defaultPreviewValues,
  extractTemplateVariables,
  unknownTemplateVariables,
} from '@/features/admin/lib/admin-prompt-templates'

export interface AdminPromptPreviewDialogProps {
  open: boolean
  entry: PromptTemplateEntryDto | null
  onClose: () => void
}

/** 渲染预览：对条目指令做 `{{变量}}` 替换，展示最终提示词与未解析变量。 */
export function AdminPromptPreviewDialog({ open, entry, onClose }: AdminPromptPreviewDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<RenderPromptTemplateResult | null>(null)
  const [error, setError] = useState('')

  const mutation = usePreviewPromptTemplate()

  const variables = entry ? extractTemplateVariables(entry.instruction) : []
  const unknown = entry ? unknownTemplateVariables(entry.instruction) : []

  function triggerPreview(instruction: string, previewValues: Record<string, string>) {
    mutation.mutate(
      { instruction, values: previewValues },
      {
        onSuccess: (data) => {
          setResult(data)
          setError('')
        },
        onError: (previewError) => {
          setResult(null)
          setError(adminErrorMessage(previewError, '渲染预览失败。'))
        },
      },
    )
  }

  useEffect(() => {
    if (!open || !entry) return
    const initial = defaultPreviewValues(variables)
    setValues(initial)
    setResult(null)
    setError('')
    triggerPreview(entry.instruction, initial)
    // 只在打开或切换条目时重新渲染，编辑变量时由「重新渲染」按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry?.id])

  function rerender() {
    if (!entry) return
    triggerPreview(entry.instruction, values)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={entry ? `预览：${entry.name}` : '预览'}
      description="用示例值替换变量，确认最终下发给模型的提示词。"
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={rerender} loading={mutation.isPending} disabled={!entry}>
            重新渲染
          </Button>
        </>
      }
    >
      {entry ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">变量 {variables.length} 个</Badge>
            {unknown.length > 0 ? <Badge tone="danger">不支持的变量：{unknown.join('、')}</Badge> : null}
          </div>

          {variables.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {variables.map((name) => (
                <Field key={name} label={`{{${name}}}`}>
                  <Input
                    value={values[name] ?? ''}
                    onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
                    spellCheck={false}
                  />
                </Field>
              ))}
            </div>
          ) : (
            <Alert tone="info" title="该模板没有变量">
              渲染结果与指令原文一致。
            </Alert>
          )}

          {error ? <Alert tone="danger" title="渲染失败">{error}</Alert> : null}

          {result ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">渲染结果</span>
                {result.hasUnresolvedVariables ? (
                  <Badge tone="warning" dot>
                    存在未填写的变量
                  </Badge>
                ) : (
                  <Badge tone="success" dot>
                    变量已全部替换
                  </Badge>
                )}
                {result.usedVariables.length > 0 ? (
                  <Badge tone="neutral">{result.usedVariables.join('、')}</Badge>
                ) : null}
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-tonal p-3 font-mono text-xs text-foreground">
                {result.rendered}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
}
