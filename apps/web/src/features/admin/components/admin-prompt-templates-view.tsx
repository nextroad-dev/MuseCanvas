'use client'

import type { CSSProperties } from 'react'
import { adminTouchTargetsSquare, adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import {
  useRef, useState } from 'react'
import { useQuery,
  useMutation,
  useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS,
  type PromptTemplateSetDetailDto } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import { Dialog } from '@/shared/components/ui/dialog'
import { useAdminActions } from '../lib/use-admin-actions'
import { AdminActionErrors } from './admin-confirm-dialog'
import { AdminQueryFeedback } from './admin-query-feedback'
import { AdminListToolbar } from './admin-list-toolbar'
import { AdminRecordDetailDialog, AdminRecordFields } from './admin-record-detail-dialog'
import { searchAdminPromptTemplates } from '../lib/admin-list-state'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardTitle,
  EmptyState,
  FormField,
  IconButton,
  Input,
  PageHeader,
  SkeletonText,
  SkeletonTile,
  Textarea,
  buttonVariants,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import { DownloadSimpleIcon as Download, FileTextIcon as FileText, PlusIcon as Plus, ArrowClockwiseIcon as RefreshCw, TrashIcon as Trash2 } from '@phosphor-icons/react'

export function AdminPromptTemplatesView() {
  const queryClient = useQueryClient()
  const recordListRef = useRef<HTMLDivElement | null>(null)
  const toast = useToast()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instruction, setInstruction] = useState('')
  const [actionError, setActionError] = useState('')
  const [search, setSearch] = useState('')
  const [detailTemplate, setDetailTemplate] = useState<PromptTemplateSetDetailDto['entries'][number] | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PromptTemplateSetDetailDto['entries'][number] | null>(null)
  const actions = useAdminActions()
  // Deletions fork the entire active set, so all entries share this serial lock.
  const deletionKey = 'active-template-set'

  const {
    data: activeSet,
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
  } = useQuery<PromptTemplateSetDetailDto | null>({
    queryKey: ['admin', 'prompt-templates'],
    queryFn: async () => {
      const res = await api<PromptTemplateSetDetailDto | null>(API_ENDPOINTS.admin.promptTemplates)
      if (!res.success) throw new Error(res.error?.message || '加载提示词模板失败')
      return res.data ?? null
    },
  })

  const entries = searchAdminPromptTemplates(activeSet?.entries ?? [], search)
  function requestDeleteTemplate(template: PromptTemplateSetDetailDto['entries'][number]) {
    setDeleteTarget(template)
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!activeSet) throw new Error('当前没有激活的模板集，请先完成实例的模板集配置')
      if (!name.trim() || !instruction.trim()) throw new Error('请完整填写名称与提示词内容')
      const res = await api(API_ENDPOINTS.admin.promptTemplateSetEntries(activeSet.id), {
        method: 'POST',
        body: {
          name: name.trim(),
          description: description.trim() || undefined,
          instruction: instruction.trim(),
        },
      })
      if (!res.success) throw new Error(res.error?.message || '创建模板失败')
      return res.data
    },
    onSuccess: async () => {
      setCreateModalOpen(false)
      setName('')
      setDescription('')
      setInstruction('')
      toast.push({ variant: 'success', title: '模板已创建' })
      await queryClient.invalidateQueries({ queryKey: ['admin', 'prompt-templates'] })
    },
    onError: (err: unknown) => {
      setActionError(err instanceof Error ? err.message : '创建模板失败')
    },
  })

  // Deleting an entry forks a new set version on the backend, so the whole
  // active-set query must be refetched rather than patched locally.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(API_ENDPOINTS.admin.promptTemplateEntry(id), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除模板失败')
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'prompt-templates'] })
    },
  })

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="提示词模板"
        description={
          activeSet
            ? `当前激活模板集：${activeSet.name}（第 ${activeSet.version} 版，${activeSet.entryCount} 个条目），供创作台快捷调用。`
            : '管理系统预置与分类提示词模板，供用户在创作台快捷调用。'
        }
        actions={
          <>
            {activeSet ? (
              <a
                href={`${API_ENDPOINTS.admin.promptTemplatesExport}?setId=${encodeURIComponent(activeSet.id)}`}
                className={buttonVariants({ variant: 'secondary' })}
              >
                <Download weight="bold" aria-hidden="true" className={iconSize.sm} />
                导出模板集
              </a>
            ) : null}
            <Button
              onClick={() => {
                setActionError('')
                setCreateModalOpen(true)
              }}
              disabled={!activeSet || actions.isPending(deletionKey) || createMutation.isPending}
              title={activeSet ? undefined : '请先导入并激活模板集'}
              icon={<Plus weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              创建模板
            </Button>
            <Button
              variant="secondary"
              onClick={() => void refetch()}
              loading={isFetching}
              icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              刷新
            </Button>
          </>
        }
      />

      <AdminListToolbar title="激活集条目" description="搜索当前版本的名称、描述和指令全文，不包含其它模板集。"
        summary={`匹配 ${entries.length} / ${activeSet?.entries.length ?? 0} 条`}
        activeCount={Number(!!search.trim())} appliedSummary={`搜索 ${search.trim()}`}
        filters={<FormField label="搜索当前激活模板集"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称、描述或指令关键词" disabled={!activeSet} /></FormField>}
        filterActions={search.trim() && <Button variant="ghost" onClick={() => setSearch('')}>清除搜索</Button>}
      />

      <AdminActionErrors errors={actions.errors} />

      {activeSet !== undefined && <AdminQueryFeedback error={error} hasData label="提示词模板" onRetry={() => { void refetch() }} />}
      {isError && activeSet === undefined ? (
        <Alert
          tone="danger"
          role="alert"
          title="无法加载提示词模板"
          action={
            <Button variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>
              刷新重试
            </Button>
          }
        >
          {error instanceof Error ? `${error.message}。请确认管理后台会话仍然有效。` : '加载数据时出现问题，请稍后重试。'}
        </Alert>
      ) : null}

      {!isLoading && activeSet !== undefined && !activeSet ? (
        <Alert tone="info" role="status" title="当前没有激活的模板集">
          <span className="flex items-start gap-2">
            <FileText weight="duotone" aria-hidden="true" className={`mt-0.5 ${iconSize.sm} shrink-0`} />
            条目管理在服务端激活的模板集上进行。当前页面不提供导入或激活接口；请先完成实例的模板集配置，再返回创建条目。
          </span>
        </Alert>
      ) : null}

      <div ref={recordListRef} tabIndex={-1} role="region" aria-label="当前提示词模板列表" className="min-w-0">
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 @min-[640px]/admin:grid-cols-2 @min-[1040px]/admin:grid-cols-3" role="status" aria-busy="true">
          <span className="sr-only">正在加载提示词模板</span>
          {Array.from({ length: 6 }, (_, index) => (
            <Card key={index} aria-hidden="true" density="compact">
              <div className="flex items-start justify-between gap-3">
                <SkeletonTile className="aspect-auto h-6 w-24 rounded-pill" />
                <SkeletonTile className={`aspect-auto ${controlSquare.sm} rounded-control`} />
              </div>
              <SkeletonText width={index % 2 === 0 ? '11rem' : '9rem'} />
              <SkeletonText lines={3} />
            </Card>
          ))}
        </div>
      ) : null}

      {!isLoading && activeSet ? (
        entries.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 @min-[640px]/admin:grid-cols-2 @min-[1040px]/admin:grid-cols-3">
            {entries.map((t, index) => (
              <Card key={t.id} density="compact" className="motion-reveal motion-stagger" style={{ '--stagger-index': index } as CSSProperties}>
                <CardBody className="h-full gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <Badge tone="neutral">模板指令</Badge>
                    <IconButton
                    className="min-h-[var(--control-md)] min-w-[var(--control-md)]"
                      variant="danger-ghost"
                      size="sm"
                      aria-label={`删除提示词模板：${t.name}`}
                      loading={!!deleteTarget && deleteTarget.id === t.id && actions.isPending(deletionKey)}
                      disabled={actions.isPending(deletionKey) || createMutation.isPending}
                      onClick={() => requestDeleteTemplate(t)}
                      icon={<Trash2 weight="bold" aria-hidden="true" className={iconSize.sm} />}
                    />
                  </div>
                  <CardTitle level={3} className="break-words [overflow-wrap:anywhere]">{t.name}</CardTitle>
                  <p className="break-words text-sm text-muted-foreground">{t.description || '通用模板'}</p>
                  <CardDescription className="line-clamp-3 whitespace-pre-wrap">{t.instruction}</CardDescription>
                  <Button variant="secondary" className="mt-auto" onClick={() => setDetailTemplate(t)}>查看指令全文</Button>
                </CardBody>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              variant={search.trim() ? 'no-results' : 'first-use'}
              objectName="提示词模板"
              title={search.trim() ? '当前激活集中没有匹配模板' : undefined}
              description={search.trim() ? '请调整或清除搜索词；搜索不包含其它模板集版本。' : undefined}
              actionLabel={search.trim() ? '清除搜索' : '创建第一个模板'}
              onAction={() => {
                if (search.trim()) setSearch('')
                else { setActionError(''); setCreateModalOpen(true) }
              }}
            />
          </Card>
        )
      ) : null}
      </div>

      <AdminRecordDetailDialog open={detailTemplate !== null || deleteTarget !== null} onClose={() => { setDetailTemplate(null); setDeleteTarget(null) }} title="提示词模板全文"
        listFocusRef={recordListRef}
        confirmation={deleteTarget ? {
          objectName: `${deleteTarget.name}（${deleteTarget.id}）`,
          impact: '删除将派生并激活新的模板集版本，影响创作台可用模板；不会直接编辑旧版本。操作与目录刷新完成前，不能删除其它条目。',
          pending: actions.isPending(deletionKey),
          error: actions.errors[deletionKey],
          cancelLabel: detailTemplate ? '返回详情' : '取消',
          onCancel: () => setDeleteTarget(null),
          onConfirm: () => {
            if (!deleteTarget || createMutation.isPending || actions.isPending(deletionKey)) return
            const target = deleteTarget
            void actions.run(deletionKey, target.name, () => deleteMutation.mutateAsync(target.id), '模板已删除', 'delete')
              .then(() => {
                setDeleteTarget((current) => current?.id === target.id ? null : current)
                setDetailTemplate((current) => current?.id === target.id ? null : current)
              }).catch(() => {})
          },
        } : undefined}
        danger={detailTemplate && <Button variant="danger-ghost" disabled={actions.isPending(deletionKey) || createMutation.isPending} onClick={() => requestDeleteTemplate(detailTemplate)}>删除此模板</Button>}>
        {detailTemplate && <>
          <AdminRecordFields fields={[
            { label: '名称', value: detailTemplate.name },
            { label: '描述', value: detailTemplate.description || '通用模板' },
          ]} />
          <div className="min-w-0"><h3 className="mb-2 text-sm font-medium">完整指令（Instruction）</h3>
            <pre className="select-text whitespace-pre-wrap break-words font-mono text-sm [overflow-wrap:anywhere]">{detailTemplate.instruction}</pre>
          </div>
        </>}
      </AdminRecordDetailDialog>

      {/* Create Modal */}
      <Dialog
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="创建提示词模板"
        size="narrow"
        panelClassName={`max-h-[90dvh] ${adminTouchTargetsSquare}`}
        footer={<>
          <Button variant="ghost" onClick={() => setCreateModalOpen(false)}>取消</Button>
          <Button type="submit" form="admin-create-template-form" disabled={!name.trim() || !instruction.trim() || actions.isPending(deletionKey)} loading={createMutation.isPending}>创建模板</Button>
        </>}
      >
        <form
          id="admin-create-template-form"
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            if (!actions.isPending(deletionKey) && !createMutation.isPending) createMutation.mutate()
          }}
        >
          {actionError ? (
            <Alert tone="danger" role="alert">
              {actionError}
            </Alert>
          ) : null}

          <FormField label="模板名称" required>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：赛博朋克都市风格"
            />
          </FormField>

          <FormField label="说明描述" hint="用于创作台的标签位置，留空时显示为通用模板。">
            <Input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例如：增强色彩对比与霓虹光效"
            />
          </FormField>

          <FormField
            label="模板指令内容（Instruction）"
            required
            hint="发送给模型的正文模板，支持 {{input_prompt}} 插值。"
          >
            <Textarea
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="输入详细的提示词引导模板…"
            />
          </FormField>

        </form>
      </Dialog>
    </div>
  )
}
