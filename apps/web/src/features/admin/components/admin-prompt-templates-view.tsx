'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowClockwiseIcon as RefreshCw,
  FileTextIcon as FileText,
  UploadSimpleIcon as Upload,
} from '@phosphor-icons/react'
import type {
  ImportPromptTemplateSetInput,
  PromptTemplateEntryDto,
  PromptTemplateSetSummaryDto,
} from '@musecanvas/contracts'
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  PageHeader,
  SectionHeader,
  Skeleton,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import {
  useActivatePromptTemplateSet,
  useAdminModels,
  useAdminPromptTemplateSet,
  useAdminPromptTemplateSets,
  useAdminPromptTemplates,
  useCreatePromptTemplateEntry,
  useDeletePromptTemplateEntry,
  useDeletePromptTemplateSet,
  useImportPromptTemplates,
  useUpdatePromptTemplateEntry,
} from '@/shared/hooks/useAdmin'
import { queryKeys } from '@/shared/hooks/query-keys'
import { cn } from '@/shared/lib/cn'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import { sortPromptEntries } from '@/features/admin/lib/admin-prompt-templates'
import { clientApi } from '@/shared/services/client-api'
import { AdminPromptEntriesCard } from './admin-prompt-entries-card'
import { AdminPromptEntryDialog } from './admin-prompt-entry-dialog'
import type { AdminPromptEntrySubmit } from './admin-prompt-entry-dialog'
import { AdminPromptImportDialog } from './admin-prompt-import-dialog'
import { AdminPromptPreviewDialog } from './admin-prompt-preview-dialog'
import { AdminPromptSetsCard } from './admin-prompt-sets-card'
import { AdminPromptOptimizationCard } from './admin-prompt-settings'

type EntryDialogState = { mode: 'create' | 'edit'; entry: PromptTemplateEntryDto | null }
type DeleteTarget =
  | { kind: 'entry'; id: string; name: string }
  | { kind: 'set'; id: string; name: string }

/**
 * 提示词模板页：模板集列表 + 条目编辑（copy-on-write）+ 导入/导出/预览
 * + 提示词优化的语言模型设置表单。
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

  const activeQuery = useAdminPromptTemplates()
  const setsQuery = useAdminPromptTemplateSets()
  const modelsQuery = useAdminModels()

  const active = activeQuery.data ?? null
  const sets = useMemo(() => setsQuery.data ?? [], [setsQuery.data])
  const languageModels = useMemo(
    () => (modelsQuery.data ?? []).filter((model) => model.modelKind === 'language'),
    [modelsQuery.data],
  )

  // 默认选中启用集；启用集变化（编辑派生新版本）后自动跟随。
  useEffect(() => {
    if (selectedId !== null) return
    const first = active?.id ?? sets[0]?.id ?? null
    if (first) setSelectedId(first)
  }, [selectedId, active?.id, sets])

  const activeSelected = selectedId !== null && active?.id === selectedId
  const detailQuery = useAdminPromptTemplateSet(!activeSelected ? selectedId : null)

  const selectedSet = activeSelected ? active : (detailQuery.data ?? null)
  const editable = selectedSet?.isActive === true

  function refreshLists() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplates })
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSets })
    if (selectedId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.promptTemplateSet(selectedId) })
    }
  }

  const activateMutation = useActivatePromptTemplateSet()
  const deleteSetMutation = useDeletePromptTemplateSet()
  const createEntryMutation = useCreatePromptTemplateEntry()
  const updateEntryMutation = useUpdatePromptTemplateEntry()
  const deleteEntryMutation = useDeletePromptTemplateEntry()
  const importMutation = useImportPromptTemplates()

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

  function handleActivateSet(setId: string) {
    setBusySetId(setId)
    activateMutation.mutate(setId, {
      onSuccess: (summary) => {
        setSelectedId(summary.id)
        toast.success(`已激活 ${summary.name} v${summary.version}`)
      },
      onError: (error) => toast.error('激活模板集失败', adminErrorMessage(error)),
      onSettled: () => setBusySetId(null),
    })
  }

  function handleEntrySubmit(values: AdminPromptEntrySubmit) {
    if (!entryDialog) return
    if (entryDialog.mode === 'edit' && entryDialog.entry) {
      const entryId = entryDialog.entry.id
      setBusyEntryId(entryId)
      updateEntryMutation.mutate(
        {
          entryId,
          input: {
            name: values.name,
            description: values.description,
            instruction: values.instruction,
            ...(values.sortOrder === undefined ? {} : { sortOrder: values.sortOrder }),
          },
        },
        {
          onSuccess: (detail) => {
            setSelectedId(detail.id)
            setEntryDialog(null)
            toast.success(`条目已保存并生成 v${detail.version}`)
          },
          onError: (error) => toast.error('保存提示词条目失败', adminErrorMessage(error)),
          onSettled: () => setBusyEntryId(null),
        },
      )
      return
    }
    if (!selectedSet) return
    setBusyEntryId('create')
    createEntryMutation.mutate(
      {
        setId: selectedSet.id,
        input: {
          name: values.name,
          description: values.description,
          instruction: values.instruction,
          ...(values.sortOrder === undefined ? {} : { sortOrder: values.sortOrder }),
        },
      },
      {
        onSuccess: (detail) => {
          setSelectedId(detail.id)
          setEntryDialog(null)
          toast.success(`已新增条目并生成 v${detail.version}`)
        },
        onError: (error) => toast.error('新增提示词条目失败', adminErrorMessage(error)),
        onSettled: () => setBusyEntryId(null),
      },
    )
  }

  function handleDeleteConfirm() {
    if (!deleteTarget) return
    if (deleteTarget.kind === 'entry') {
      const entryId = deleteTarget.id
      setBusyEntryId(entryId)
      deleteEntryMutation.mutate(entryId, {
        onSuccess: (result) => {
          if (result.setId) setSelectedId(result.setId)
          setDeleteTarget(null)
          toast.success('条目已删除并生成新版本')
        },
        onError: (error) => toast.error('删除提示词条目失败', adminErrorMessage(error)),
        onSettled: () => setBusyEntryId(null),
      })
    } else {
      const setId = deleteTarget.id
      setBusySetId(setId)
      deleteSetMutation.mutate(setId, {
        onSuccess: () => {
          if (selectedId === setId) setSelectedId(active?.id ?? null)
          setDeleteTarget(null)
          toast.success('模板集版本已删除')
        },
        onError: (error) => toast.error('删除模板集失败', adminErrorMessage(error)),
        onSettled: () => setBusySetId(null),
      })
    }
  }

  function handleImportSubmit(input: ImportPromptTemplateSetInput) {
    importMutation.mutate(input, {
      onSuccess: (result) => {
        setImportOpen(false)
        setSelectedId(result.setId)
        toast.success(
          `已导入 ${result.entryCount} 条模板`,
          result.isActive ? `已激活 ${result.name} v${result.version}` : '已保存为历史版本，可手动激活。',
        )
      },
      onError: (error) => toast.error('导入模板集失败', adminErrorMessage(error)),
    })
  }

  const queryError = activeQuery.error ?? setsQuery.error
  const busyEntryDialog = createEntryMutation.isPending || updateEntryMutation.isPending
  const busyDelete = deleteEntryMutation.isPending || deleteSetMutation.isPending

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="提示词模板"
        description="管理生成用的提示词模板集与语言模型优化设置。模板按版本 copy-on-write：编辑条目会自动生成新的启用版本，历史版本仍可查看与回滚。"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex items-center justify-center rounded-control bg-accent-soft text-accent',
                controlSquare.xs,
              )}
            >
              <FileText weight="duotone" aria-hidden="true" className={iconSize.sm} />
            </span>
            <span className="text-caption font-medium text-muted-foreground">生成资源</span>
            {active ? (
              <Badge tone="success" dot>
                当前启用：{active.name} v{active.version}
              </Badge>
            ) : null}
          </div>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void Promise.all([activeQuery.refetch(), setsQuery.refetch()])}
              loading={activeQuery.isFetching || setsQuery.isFetching}
              leadingIcon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              刷新
            </Button>
            <Button
              size="sm"
              onClick={() => setImportOpen(true)}
              leadingIcon={<Upload weight="bold" aria-hidden="true" className={iconSize.sm} />}
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
        <Card className="gap-3" role="status" aria-label="正在加载提示词模板">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : null}

      <AdminPromptSetsCard
        active={active}
        sets={sets}
        selectedId={selectedId}
        busySetId={busySetId}
        exportHref={(setId) => clientApi.admin.promptTemplatesExportUrl(setId)}
        onSelect={setSelectedId}
        onActivate={handleActivateSet}
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

      <section aria-labelledby="admin-prompt-lm-settings" className="flex min-w-0 flex-col gap-4">
        <SectionHeader
          id="admin-prompt-lm-settings"
          title="语言模型相关设置"
          description="从当前实例已配置并启用的语言模型中选择；启用提示词优化前必须先选择可用模型。"
        />
        {modelsQuery.isError ? (
          <Alert tone="warning" title="语言模型列表加载失败">
            {adminErrorMessage(modelsQuery.error, '请刷新页面后重试；保存时仍会做服务端校验。')}
          </Alert>
        ) : null}
        <AdminPromptOptimizationCard models={languageModels} />
      </section>

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
        onSubmit={handleImportSubmit}
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
