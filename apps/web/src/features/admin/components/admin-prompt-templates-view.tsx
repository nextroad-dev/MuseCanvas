'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowClockwiseIcon as RefreshCw, UploadSimpleIcon as Upload } from '@phosphor-icons/react'
import type {
  ImportPromptTemplateSetInput,
  PromptTemplateEntryDto,
  PromptTemplateSetSummaryDto,
} from '@musecanvas/contracts'
import { Alert } from '@/shared/components/ui/alert'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { Dialog } from '@/shared/components/ui/dialog'
import { PageHeader } from '@/shared/components/ui/page-header'
import { useToast } from '@/shared/components/ui/toast'
import { iconSize } from '@/shared/components/ui/size'
import { queryKeys } from '@/shared/hooks/query-keys'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import { sortPromptEntries } from '@/features/admin/lib/admin-prompt-templates'
import { clientApi } from '@/shared/services/client-api'
import { AdminPromptEntriesCard } from './admin-prompt-entries-card'
import { AdminPromptEntryDialog } from './admin-prompt-entry-dialog'
import type { AdminPromptEntrySubmit } from './admin-prompt-entry-dialog'
import { AdminPromptImportDialog } from './admin-prompt-import-dialog'
import { AdminPromptPreviewDialog } from './admin-prompt-preview-dialog'
import { AdminPromptSetsCard } from './admin-prompt-sets-card'
import { AdminPromptOptimizationCard, AdminPromptAgentCard } from './admin-prompt-settings'

type EntryDialogState = { mode: 'create' | 'edit'; entry: PromptTemplateEntryDto | null }
type DeleteTarget =
  | { kind: 'entry'; id: string; name: string }
  | { kind: 'set'; id: string; name: string }

const detailQueryKey = (setId: string) => [...queryKeys.admin.promptTemplateSets, 'detail', setId] as const

/**
 * 提示词模板页：模板集列表 + 条目编辑（copy-on-write）+ 导入/导出/预览
 * + 提示词优化与创作助手两张语言模型设置表单。
 */
export function AdminPromptTemplatesView() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [entryDialog, setEntryDialog] = useState<EntryDialogState | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [previewEntry, setPreviewEntry] = useState<PromptTemplateEntryDto | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [busySetId, setBusySetId] = useState<string | null>(null)
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null)

  const activeQuery = useQuery({
    queryKey: queryKeys.admin.promptTemplates,
    queryFn: () => clientApi.admin.getActivePromptTemplates(),
    staleTime: 30_000,
  })
  const setsQuery = useQuery({
    queryKey: queryKeys.admin.promptTemplateSets,
    queryFn: () => clientApi.admin.listPromptTemplateSets(),
    staleTime: 30_000,
  })
  const modelsQuery = useQuery({
    queryKey: queryKeys.admin.models,
    queryFn: () => clientApi.admin.listModels(),
    staleTime: 60_000,
  })

  const active = activeQuery.data ?? null
  const sets = useMemo(() => setsQuery.data ?? [], [setsQuery.data])
  const languageModels = (modelsQuery.data ?? []).filter((model) => model.modelKind === 'language')

  // 默认选中启用集；启用集变化（编辑派生新版本）后自动跟随。
  useEffect(() => {
    if (selectedId !== null) return
    const first = active?.id ?? sets[0]?.id ?? null
    if (first) setSelectedId(first)
  }, [selectedId, active?.id, sets])

  const activeSelected = selectedId !== null && active?.id === selectedId
  const detailQuery = useQuery({
    queryKey: detailQueryKey(selectedId ?? 'none'),
    queryFn: () => clientApi.admin.getPromptTemplateSet(selectedId ?? ''),
    enabled: selectedId !== null && !activeSelected,
    staleTime: 30_000,
  })

  const selectedSet = activeSelected ? active : (detailQuery.data ?? null)
  const editable = selectedSet?.isActive === true

  function refreshLists() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
  }

  const activateMutation = useMutation({
    mutationFn: (setId: string) => clientApi.admin.activatePromptTemplateSet(setId),
    onMutate: (setId) => setBusySetId(setId),
    onSuccess: (summary) => {
      refreshLists()
      setSelectedId(summary.id)
      toast.success(`已激活 ${summary.name} v${summary.version}`)
    },
    onError: (error) => toast.error('激活模板集失败', adminErrorMessage(error)),
    onSettled: () => setBusySetId(null),
  })

  const deleteSetMutation = useMutation({
    mutationFn: (setId: string) => clientApi.admin.deletePromptTemplateSet(setId),
    onMutate: (setId) => setBusySetId(setId),
    onSuccess: (_result, setId) => {
      refreshLists()
      if (selectedId === setId) setSelectedId(active?.id ?? null)
      setDeleteTarget(null)
      toast.success('模板集版本已删除')
    },
    onError: (error) => toast.error('删除模板集失败', adminErrorMessage(error)),
    onSettled: () => setBusySetId(null),
  })

  const createEntryMutation = useMutation({
    mutationFn: (variables: { setId: string; input: AdminPromptEntrySubmit }) =>
      clientApi.admin.createPromptTemplateEntry(variables.setId, {
        name: variables.input.name,
        description: variables.input.description,
        instruction: variables.input.instruction,
        ...(variables.input.sortOrder === undefined ? {} : { sortOrder: variables.input.sortOrder }),
      }),
    onMutate: () => setBusyEntryId('create'),
    onSuccess: (detail) => {
      refreshLists()
      setSelectedId(detail.id)
      setEntryDialog(null)
      toast.success(`已新增条目并生成 v${detail.version}`)
    },
    onError: (error) => toast.error('新增提示词条目失败', adminErrorMessage(error)),
    onSettled: () => setBusyEntryId(null),
  })

  const updateEntryMutation = useMutation({
    mutationFn: (variables: { entryId: string; input: AdminPromptEntrySubmit }) =>
      clientApi.admin.updatePromptTemplateEntry(variables.entryId, {
        name: variables.input.name,
        description: variables.input.description,
        instruction: variables.input.instruction,
        ...(variables.input.sortOrder === undefined ? {} : { sortOrder: variables.input.sortOrder }),
      }),
    onMutate: (variables) => setBusyEntryId(variables.entryId),
    onSuccess: (detail) => {
      refreshLists()
      setSelectedId(detail.id)
      setEntryDialog(null)
      toast.success(`条目已保存并生成 v${detail.version}`)
    },
    onError: (error) => toast.error('保存提示词条目失败', adminErrorMessage(error)),
    onSettled: () => setBusyEntryId(null),
  })

  const deleteEntryMutation = useMutation({
    mutationFn: (entryId: string) => clientApi.admin.deletePromptTemplateEntry(entryId),
    onMutate: (entryId) => setBusyEntryId(entryId),
    onSuccess: (result) => {
      refreshLists()
      if (result.setId) setSelectedId(result.setId)
      setDeleteTarget(null)
      toast.success('条目已删除并生成新版本')
    },
    onError: (error) => toast.error('删除提示词条目失败', adminErrorMessage(error)),
    onSettled: () => setBusyEntryId(null),
  })

  /** 上移/下移：两次 PATCH 交换 sortOrder；每次返回新的 fork，第二次用新 id。 */
  const reorderMutation = useMutation({
    mutationFn: async (variables: { entry: PromptTemplateEntryDto; direction: -1 | 1 }) => {
      if (!selectedSet) throw new Error('当前没有可编辑的模板集。')
      const entries = sortPromptEntries(selectedSet.entries)
      const index = entries.findIndex((candidate) => candidate.id === variables.entry.id)
      const neighbor = entries[index + variables.direction]
      if (index < 0 || !neighbor) throw new Error('已经到达排序边界。')
      if (neighbor.sortOrder === variables.entry.sortOrder) {
        throw new Error('两条模板排序值相同，请通过「编辑」直接修改排序值。')
      }
      const first = await clientApi.admin.updatePromptTemplateEntry(variables.entry.id, {
        sortOrder: neighbor.sortOrder,
      })
      const movedNeighbor = first.entries.find((candidate) => candidate.name === neighbor.name)
      if (!movedNeighbor) throw new Error('排序后未能定位相邻条目，请刷新后重试。')
      return clientApi.admin.updatePromptTemplateEntry(movedNeighbor.id, {
        sortOrder: variables.entry.sortOrder,
      })
    },
    onMutate: (variables) => setBusyEntryId(variables.entry.id),
    onSuccess: (detail) => {
      refreshLists()
      setSelectedId(detail.id)
      toast.success('排序已更新')
    },
    onError: (error) => toast.error('调整排序失败', adminErrorMessage(error)),
    onSettled: () => setBusyEntryId(null),
  })

  const importMutation = useMutation({
    mutationFn: (input: ImportPromptTemplateSetInput) => clientApi.admin.importPromptTemplates(input),
    onSuccess: (result) => {
      refreshLists()
      setImportOpen(false)
      setSelectedId(result.setId)
      toast.success(
        `已导入 ${result.entryCount} 条模板`,
        result.isActive ? `已激活 ${result.name} v${result.version}` : '已保存为历史版本，可手动激活。',
      )
    },
    onError: (error) => toast.error('导入模板集失败', adminErrorMessage(error)),
  })

  function handleEntrySubmit(values: AdminPromptEntrySubmit) {
    if (!entryDialog) return
    if (entryDialog.mode === 'edit' && entryDialog.entry) {
      updateEntryMutation.mutate({ entryId: entryDialog.entry.id, input: values })
      return
    }
    if (!selectedSet) return
    createEntryMutation.mutate({ setId: selectedSet.id, input: values })
  }

  function handleDeleteConfirm() {
    if (!deleteTarget) return
    if (deleteTarget.kind === 'entry') deleteEntryMutation.mutate(deleteTarget.id)
    else deleteSetMutation.mutate(deleteTarget.id)
  }

  const queryError = activeQuery.error ?? setsQuery.error
  const busyEntryDialog = createEntryMutation.isPending || updateEntryMutation.isPending
  const busyDelete = deleteEntryMutation.isPending || deleteSetMutation.isPending

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="提示词模板"
        description="管理生成用的提示词模板集与语言模型相关设置。模板按版本 copy-on-write：编辑条目会自动生成新的启用版本，历史版本仍可查看与回滚。"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => void Promise.all([activeQuery.refetch(), setsQuery.refetch()])}
              loading={activeQuery.isFetching || setsQuery.isFetching}
              icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              刷新
            </Button>
            <Button
              onClick={() => setImportOpen(true)}
              icon={<Upload weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              导入模板集
            </Button>
          </>
        }
      />

      {queryError ? (
        <Alert
          tone="danger"
          title="读取模板数据失败"
          action={
            <Button variant="secondary" size="sm" onClick={refreshLists}>
              重试
            </Button>
          }
        >
          {adminErrorMessage(queryError, '请检查管理员会话与网络后重试。')}
        </Alert>
      ) : null}

      {activeQuery.isLoading && setsQuery.isLoading ? (
        <Card>
          <p role="status" className="text-sm text-muted-foreground">
            正在加载提示词模板…
          </p>
        </Card>
      ) : null}

      <AdminPromptSetsCard
        active={active}
        sets={sets}
        selectedId={selectedId}
        busySetId={busySetId}
        exportHref={(setId) => clientApi.admin.promptTemplatesExportUrl(setId)}
        onSelect={setSelectedId}
        onActivate={(setId) => activateMutation.mutate(setId)}
        onDelete={(set: PromptTemplateSetSummaryDto) => setDeleteTarget({ kind: 'set', id: set.id, name: set.name })}
      />

      <AdminPromptEntriesCard
        set={selectedSet}
        editable={editable}
        busyEntryId={busyEntryId}
        onAdd={() => setEntryDialog({ mode: 'create', entry: null })}
        onEdit={(entry) => setEntryDialog({ mode: 'edit', entry })}
        onDelete={(entry) => setDeleteTarget({ kind: 'entry', id: entry.id, name: entry.name })}
        onPreview={setPreviewEntry}
        onMove={(entry, direction) => reorderMutation.mutate({ entry, direction })}
        onExport={() => {
          if (selectedSet) window.open(clientApi.admin.promptTemplatesExportUrl(selectedSet.id), '_blank', 'noopener')
        }}
      />

      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-section text-foreground">语言模型相关设置</h2>
        <p className="text-sm text-muted-foreground">
          两张表单共用 /admin/language-models 中已启用的语言模型；启用任一功能前必须先选择模型。
        </p>
        {modelsQuery.isError ? (
          <Alert tone="warning" title="语言模型列表加载失败">
            {adminErrorMessage(modelsQuery.error, '请刷新页面后重试；保存时仍会做服务端校验。')}
          </Alert>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <AdminPromptOptimizationCard models={languageModels} />
        <AdminPromptAgentCard models={languageModels} />
      </div>

      <AdminPromptEntryDialog
        open={entryDialog !== null}
        mode={entryDialog?.mode ?? 'create'}
        entry={entryDialog?.entry ?? null}
        busy={busyEntryDialog}
        onClose={() => setEntryDialog(null)}
        onSubmit={handleEntrySubmit}
      />

      <AdminPromptImportDialog
        open={importOpen}
        busy={importMutation.isPending}
        onClose={() => setImportOpen(false)}
        onSubmit={(input) => importMutation.mutate(input)}
      />

      <AdminPromptPreviewDialog
        open={previewEntry !== null}
        entry={previewEntry}
        onClose={() => setPreviewEntry(null)}
      />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget?.kind === 'set' ? '删除模板集版本？' : '删除这条模板？'}
        description={
          deleteTarget?.kind === 'set'
            ? '删除的是该历史版本；启用中的版本不能删除。'
            : '删除会派生一个不含该条目的新版本，历史版本保持不变。'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={busyDelete}>
              取消
            </Button>
            <Button variant="danger" onClick={handleDeleteConfirm} loading={busyDelete}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          {deleteTarget
            ? `将删除「${deleteTarget.name}」${deleteTarget.kind === 'set' ? '模板集版本' : '条目'}。此操作不可撤销。`
            : ''}
        </p>
        {deleteTarget?.kind === 'entry' ? (
          <p className="mt-2 text-xs text-muted-foreground">
            模板集至少要保留一条模板；如果这是最后一条，删除会被拒绝。
          </p>
        ) : null}
      </Dialog>
    </div>
  )
}
