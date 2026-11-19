'use client'

import { useEffect, useState } from 'react'
import { FileArrowUpIcon as FileUp } from '@phosphor-icons/react'
import type { ImportPromptTemplateSetInput } from '@musecanvas/contracts'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  FieldGroup,
  Input,
  Switch,
  Textarea,
  controlMinHeight,
  iconSize,
} from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import {
  PROMPT_MAX_ENTRIES,
  parsePromptImportPayload,
  readPromptImportFile,
} from '@/features/admin/lib/admin-prompt-templates'
import type { ParsedPromptImport } from '@/features/admin/lib/admin-prompt-templates'

export interface AdminPromptImportDialogProps {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (input: ImportPromptTemplateSetInput) => void
}

/**
 * 导入模板集：上传 JSON 文件或直接粘贴 JSON，解析后展示名称 / 条数 / 激活开关。
 * 导入永远是新增版本，不会修改历史集；`activate` 默认打开以便立即生效。
 */
export function AdminPromptImportDialog({ open, busy, onClose, onSubmit }: AdminPromptImportDialogProps) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<ParsedPromptImport | null>(null)
  const [name, setName] = useState('')
  const [activate, setActivate] = useState(true)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')

  useEffect(() => {
    if (!open) return
    setText('')
    setParsed(null)
    setName('')
    setActivate(true)
    setError('')
    setFileName('')
  }, [open])

  function applyText(raw: string, fallbackName: string) {
    const result = parsePromptImportPayload(raw, fallbackName)
    if (result.error || !result.parsed) {
      setParsed(null)
      setError(result.error ?? '导入内容无效。')
      return
    }
    setParsed(result.parsed)
    setName(result.parsed.name)
    setError('')
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    setFileName(file.name)
    try {
      const raw = await readPromptImportFile(file)
      setText(raw)
      applyText(raw, file.name.replace(/\.json$/i, '') || '导入模板集')
    } catch (readError) {
      setParsed(null)
      setError(readError instanceof Error ? readError.message : '读取文件失败。')
    }
  }

  function handleSubmit() {
    if (!parsed) return
    onSubmit({
      name: name.trim() || parsed.name,
      activate,
      templates: parsed.templates,
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="导入提示词模板集"
      description="接受导出文件、模板数组，或 { name, activate, templates: [...] } 结构；导入会生成新版本。"
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={handleSubmit} loading={busy} disabled={!parsed}>
            导入模板集
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldGroup className="gap-4">
          <Field
            label="从文件导入"
            hint={`选择 .json 文件（导出文件可直接回导），最多 ${PROMPT_MAX_ENTRIES} 条、2MB。`}
          >
            <label
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-control border border-dashed border-border-control bg-tonal px-3 text-sm text-foreground transition-colors hover:bg-tonal-hover',
                controlMinHeight.lg,
              )}
            >
              <FileUp weight="bold" aria-hidden="true" className={iconSize.sm} />
              <span className="truncate">{fileName || '选择 JSON 文件'}</span>
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                disabled={busy}
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
            </label>
          </Field>

          <Field label="或粘贴 JSON" error={error} hint="支持导出文件原文、模板数组或带 templates/entries 的对象。">
            <Textarea
              value={text}
              onChange={(event) => {
                const raw = event.target.value
                setText(raw)
                if (raw.trim() === '') {
                  setParsed(null)
                  setError('')
                  return
                }
                applyText(raw, fileName.replace(/\.json$/i, '') || '导入模板集')
              }}
              rows={8}
              spellCheck={false}
              placeholder={'{\n  "name": "默认模板集",\n  "templates": [\n    { "name": "示例", "instruction": "{{input_prompt}}" }\n  ]\n}'}
              className="font-mono text-xs"
              disabled={busy}
            />
          </Field>
        </FieldGroup>

        {parsed ? (
          <div className="flex flex-col gap-3 rounded-control border border-border/70 bg-tonal p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="success" dot>
                解析成功
              </Badge>
              <Badge tone="neutral">{parsed.templates.length} 条模板</Badge>
            </div>
            <Field label="模板集名称" hint="留空使用 JSON 内的 name 或文件名。">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                disabled={busy}
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">导入后立即激活</span>
                <span className="text-xs text-muted-foreground">关闭时只新增历史版本，可稍后手动激活。</span>
              </div>
              <Switch aria-label="导入后立即激活" checked={activate} onCheckedChange={setActivate} disabled={busy} />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">条目预览</p>
              <ul className="flex flex-col gap-1 text-sm text-foreground">
                {parsed.templates.slice(0, 5).map((template) => (
                  <li key={template.name} className="truncate">
                    · {template.name}
                  </li>
                ))}
                {parsed.templates.length > 5 ? (
                  <li className="text-xs text-muted-foreground">…以及另外 {parsed.templates.length - 5} 条</li>
                ) : null}
              </ul>
            </div>
          </div>
        ) : null}

        {!parsed && text.trim() !== '' && !error ? (
          <Alert tone="info" title="等待解析">
            粘贴或选择 JSON 后会自动解析；解析成功才会显示导入按钮。
          </Alert>
        ) : null}
      </div>
    </Dialog>
  )
}
