'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { PlusIcon } from '@phosphor-icons/react'
import type { PromptTemplateEntryDto } from '@musecanvas/contracts'
import { Button } from '@/shared/components/ui/button'
import { Dialog } from '@/shared/components/ui/dialog'
import { Field, FieldGroup } from '@/shared/components/ui/field'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { iconSize } from '@/shared/components/ui/size'
import {
  PROMPT_MAX_DESCRIPTION_LENGTH,
  PROMPT_MAX_NAME_LENGTH,
  PROMPT_VARIABLE_META,
  PROMPT_VARIABLE_NAMES,
  hasFormErrors,
  validatePromptEntryForm,
} from '@/features/admin/lib/admin-prompt-templates'
import type { PromptEntryFormValues } from '@/features/admin/lib/admin-prompt-templates'

export type AdminPromptEntryDialogMode = 'create' | 'edit'

export interface AdminPromptEntrySubmit {
  name: string
  description: string
  instruction: string
  sortOrder?: number
}

export interface AdminPromptEntryDialogProps {
  open: boolean
  mode: AdminPromptEntryDialogMode
  entry: PromptTemplateEntryDto | null
  busy: boolean
  onClose: () => void
  onSubmit: (values: AdminPromptEntrySubmit) => void
}

const FORM_ID = 'admin-prompt-entry-form'

function initialValues(mode: AdminPromptEntryDialogMode, entry: PromptTemplateEntryDto | null): PromptEntryFormValues {
  if (mode === 'edit' && entry) {
    return {
      name: entry.name,
      description: entry.description,
      instruction: entry.instruction,
      sortOrder: String(entry.sortOrder),
    }
  }
  return { name: '', description: '', instruction: '', sortOrder: '' }
}

/** 新建 / 编辑条目：变量白名单、128KB 上限、排序值都在客户端先校验。 */
export function AdminPromptEntryDialog({ open, mode, entry, busy, onClose, onSubmit }: AdminPromptEntryDialogProps) {
  const [values, setValues] = useState<PromptEntryFormValues>(() => initialValues(mode, entry))
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    if (!open) return
    setValues(initialValues(mode, entry))
    setErrors({})
  }, [open, mode, entry])

  function patch(patchValues: Partial<PromptEntryFormValues>) {
    setValues((current) => ({ ...current, ...patchValues }))
  }

  function insertVariable(name: string) {
    setValues((current) => {
      const instruction = current.instruction
      const spacer = instruction === '' || instruction.endsWith(' ') || instruction.endsWith('\n') ? '' : ' '
      return { ...current, instruction: `${instruction}${spacer}{{${name}}}` }
    })
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = validatePromptEntryForm(values)
    setErrors(nextErrors)
    if (hasFormErrors(nextErrors)) return
    const sortOrderText = values.sortOrder.trim()
    onSubmit({
      name: values.name.trim(),
      description: values.description.trim(),
      instruction: values.instruction,
      ...(sortOrderText === '' ? {} : { sortOrder: Number(sortOrderText) }),
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === 'create' ? '新增提示词模板' : '编辑提示词模板'}
      description="保存时会派生新的当前版本（copy-on-write）；历史版本不会被修改。"
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form={FORM_ID} loading={busy}>
            {mode === 'create' ? '创建条目' : '保存修改'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
        <FieldGroup className="gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field label="名称" required error={errors.name} hint={`最多 ${PROMPT_MAX_NAME_LENGTH} 个字符，同一模板集内不可重复。`}>
              <Input
                value={values.name}
                onChange={(event) => patch({ name: event.target.value })}
                maxLength={PROMPT_MAX_NAME_LENGTH}
                placeholder="例如：摄影风格增强"
                disabled={busy}
                autoFocus
              />
            </Field>
            <Field label="排序值" error={errors.sortOrder} hint="留空自动放到末尾。">
              <Input
                value={values.sortOrder}
                onChange={(event) => patch({ sortOrder: event.target.value })}
                inputMode="numeric"
                placeholder="0"
                disabled={busy}
              />
            </Field>
          </div>

          <Field
            label="描述"
            error={errors.description}
            hint={`显示在后台列表与创作台的模板标签里，最多 ${PROMPT_MAX_DESCRIPTION_LENGTH} 个字符。`}
          >
            <Input
              value={values.description}
              onChange={(event) => patch({ description: event.target.value })}
              maxLength={PROMPT_MAX_DESCRIPTION_LENGTH}
              placeholder="用一句话说明这条模板的用途"
              disabled={busy}
            />
          </Field>

          <Field
            label="指令内容"
            required
            error={errors.instruction}
            hint="支持下列变量；未知变量与未闭合花括号会被拒绝。上限 128KB。"
          >
            <Textarea
              value={values.instruction}
              onChange={(event) => patch({ instruction: event.target.value })}
              rows={10}
              spellCheck={false}
              placeholder={'把下面这段用户描述扩展成高质量图像提示词：\n{{input_prompt}}'}
              disabled={busy}
              className="font-mono text-xs"
            />
          </Field>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">可用变量（点击插入到指令末尾）</p>
            <div className="flex flex-wrap gap-1.5">
              {PROMPT_VARIABLE_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => insertVariable(name)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-pill border border-border px-2.5 py-1 font-mono text-xs text-foreground transition-colors hover:bg-tonal-hover disabled:pointer-events-none disabled:opacity-45"
                >
                  <PlusIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                  {`{{${name}}}`}
                  <span className="font-sans text-muted-foreground">
                    {PROMPT_VARIABLE_META[name as keyof typeof PROMPT_VARIABLE_META]?.label ?? ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </FieldGroup>
      </form>
    </Dialog>
  )
}
