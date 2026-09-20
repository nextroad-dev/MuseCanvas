'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { PromptTemplate } from '@/shared/types'
import { FileText, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'

export function AdminPromptTemplatesView() {
  const queryClient = useQueryClient()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instruction, setInstruction] = useState('')
  const [actionError, setActionError] = useState('')

  const {
    data: templates = [],
    isLoading,
    refetch,
  } = useQuery<PromptTemplate[]>({
    queryKey: ['admin', 'prompt-templates'],
    queryFn: async () => {
      const res = await api<{ entries: PromptTemplate[] } | PromptTemplate[]>('/api/admin/prompt-templates')
      if (Array.isArray(res.data)) return res.data
      return (res.data as any)?.entries || []
    },
  })


  const createMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim() || !instruction.trim()) throw new Error('请完整填写名称与提示词内容')
      const res = await api('/api/admin/prompt-templates', {
        method: 'POST',
        body: {
          name: name.trim(),
          description: description.trim() || null,
          instruction: instruction.trim(),
          enabled: true,
        },
      })
      if (!res.success) throw new Error(res.error?.message || '创建模板失败')
      return res.data
    },
    onSuccess: () => {
      setCreateModalOpen(false)
      setName('')
      setDescription('')
      setInstruction('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'prompt-templates'] })
    },
    onError: (err: any) => {
      setActionError(err.message || '创建模板失败')
    },
  })


  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(`/api/admin/prompt-templates/${id}`, { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除模板失败')
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'prompt-templates'] })
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">提示词模板</h1>
          <p className="text-sm text-muted-foreground">管理系统预置与分类提示词模板，供用户在创作台快捷调用。</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setActionError('')
              setCreateModalOpen(true)
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            添加模板
          </button>
          <button
            type="button"
            onClick={() => refetch()}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          <div className="col-span-full p-8 text-center text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
          </div>
        ) : templates.length > 0 ? (
          templates.map((t) => (
            <div
              key={t.id}
              className="flex flex-col justify-between rounded-[var(--radius-card)] border border-border bg-surface p-4"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="inline-flex rounded bg-surface-subtle px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {t.description || '通用模板'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`确认删除模板 ${t.name}？`)) {
                        deleteMutation.mutate(t.id)
                      }
                    }}
                    className="text-muted-foreground hover:text-danger p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <h3 className="mt-2 font-semibold text-foreground text-sm">{t.name}</h3>
                <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{t.instruction}</p>
              </div>
            </div>
          ))
        ) : (
          <div className="col-span-full rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
            暂无提示词模板
          </div>
        )}
      </div>

      {/* Create Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setCreateModalOpen(false)} />
          <div className="relative z-10 w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground">添加提示词模板</h3>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {actionError && (
              <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger">
                {actionError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">模板名称</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如: 赛博朋克都市风格"
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">说明描述</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如: 增强色彩对比与霓虹光效"
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">模板指令内容 (Instruction)</label>
                <textarea
                  rows={4}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="输入详细的提示词引导模板，支持 {{prompt}} 插值..."
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-subtle"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !name.trim() || !instruction.trim()}
                className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
              >
                {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                创建模板
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
