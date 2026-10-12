'use client'

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { ProviderCredential, ProviderTestStatus } from '@/shared/types'
import { credentialPluginKey } from '../lib/provider-templates'
import { useAdminActions } from '../lib/use-admin-actions'
import { AdminActionErrors } from './admin-confirm-dialog'
import { AdminMobileRecords, AdminRecordDetailDialog, AdminRecordFields } from './admin-record-detail-dialog'
import { TrashIcon as Trash2 } from '@phosphor-icons/react'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  IconButton,
  SkeletonText,
  SkeletonTile,
  Switch,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
} from '@/shared/components/ui'

interface AdminCredentialTableProps {
  credentials: ProviderCredential[]
  isLoading: boolean
  /**
   * `media` rows were created from a plugin template and show that plugin and
   * their provider account; `language` rows were created without one (provider +
   * API key) and show which models consume them.
   */
  variant: 'media' | 'language'
  /** Model display names keyed by the credential id they are bound to. */
  linkedModels?: Record<string, string[]>
  /** First-use copy: what is missing and how to create it. */
  emptyText: string
  /** List request failed — renders the `error` empty state instead of first-use. */
  error?: ReactNode
  /** Retry handler for the `error` state; wired to the caller's existing `refetch`. */
  onRetry?: () => void
}

const TEST_STATUS_LABEL: Record<ProviderTestStatus, string> = {
  success: '测试通过',
  failed: '测试失败',
  not_tested: '未测试',
  pending: '测试中',
}

// Shared credential console merged out of the former 供应商凭据 page: list,
// enable/disable, connectivity test and delete. Creation lives in each page's
// dialog because the payload shape differs per scope.
export function AdminCredentialTable({
  credentials,
  isLoading,
  variant,
  linkedModels = {},
  emptyText,
  error,
  onRetry,
}: AdminCredentialTableProps) {
  const queryClient = useQueryClient()
  const recordListRef = useRef<HTMLDivElement | null>(null)
  const [detailCredential, setDetailCredential] = useState<ProviderCredential | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProviderCredential | null>(null)
  const actions = useAdminActions()

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(API_ENDPOINTS.admin.providerCredential(id), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除凭据失败')
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await api(API_ENDPOINTS.admin.providerCredential(id), { method: 'PATCH', body: { enabled } })
      if (!res.success) throw new Error(res.error?.message || '更新凭据状态失败')
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
    },
  })

  async function handleTest(credential: ProviderCredential) {
    await actions.run(credential.id, credential.displayName, async () => {
      try {
        const res = await api<{ tested: boolean; status: string }>(API_ENDPOINTS.admin.providerCredentialTest(credential.id), {
          method: 'POST',
        })
        if (!res.success || (res.data?.status !== 'pending' && !(res.data?.tested && res.data.status === 'success'))) {
          throw new Error(res.error?.message || '连通性测试未通过')
        }
        return res.data
      } finally {
        // Even a failed test may stamp the last-test status on the server.
        await queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
      }
    }, '连通测试请求已完成；最终结果请查看最近测试', 'test')
  }

  const currentDetailCredential = credentials.find((credential) => credential.id === detailCredential?.id) ?? detailCredential
  function requestDeleteCredential(credential: ProviderCredential) {
    setDeleteTarget(credential)
  }
  function credentialBusy(credential: ProviderCredential) {
    return actions.isPending(credential.id) || credential.lastTestStatus === 'pending'
  }
  function toggleCredential(credential: ProviderCredential, enabled: boolean) {
    return actions.run(credential.id, credential.displayName, () => toggleMutation.mutateAsync({ id: credential.id, enabled }), enabled ? '凭据已启用' : '凭据已停用', 'toggle')
  }

  return (
    <div ref={recordListRef} tabIndex={-1} role="region" aria-label="供应商凭据列表" className="flex flex-col gap-3">
      <AdminActionErrors errors={actions.errors} />

      <AdminMobileRecords records={credentials} loading={isLoading}
        error={error ? typeof error === 'string' ? error : '加载凭据失败' : null}
        onRetry={onRetry} empty={emptyText}
        title={(credential) => credential.displayName}
        status={(credential) => <Badge tone={credential.enabled ? 'success' : 'neutral'}>{credential.enabled ? '已启用' : '已停用'}</Badge>}
        summary={(credential) => <>{credential.providerId || credential.adapter || '—'} · 最近测试：{TEST_STATUS_LABEL[credential.lastTestStatus] || credential.lastTestStatus}</>}
        onDetails={setDetailCredential}
      />

      <DataTable cardClassName="hidden @min-[800px]/admin:block" caption={variant === 'media' ? '媒体供应商凭据列表' : '语言模型供应商凭据列表'} columns={5}>
        <TableHead>
          <TableHeadCell>凭据名称</TableHeadCell>
          <TableHeadCell>{variant === 'media' ? '插件与供应商' : '供应商与引用'}</TableHeadCell>
          <TableHeadCell>API Key 状态</TableHeadCell>
          <TableHeadCell>状态</TableHeadCell>
          <TableHeadCell align="right">操作</TableHeadCell>
        </TableHead>
        <TableBody busy={isLoading}>
          {isLoading ? (
            Array.from({ length: 3 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <div key="name" className="flex flex-col gap-1"><SkeletonText width="9rem" /><SkeletonText width="8rem" /></div>,
                  <SkeletonText key="provider" lines={2} width="9rem" />,
                  <SkeletonTile key="key" className="aspect-auto h-6 w-24 rounded-pill" />,
                  <div key="status" className="flex items-center gap-2"><SkeletonTile className="aspect-auto h-5 w-9 rounded-pill" /><SkeletonText width="3rem" /></div>,
                  { align: 'right', content: <div className="flex flex-wrap items-center justify-end gap-2"><SkeletonTile className="aspect-auto h-8 w-20 rounded-control" /><SkeletonTile className="aspect-auto h-8 w-8 rounded-control" /></div> },
                ]}
              />
            ))
          ) : error ? (
            <TableStateRow>
              <EmptyState
                variant="error"
                density="compact"
                objectName={variant === 'media' ? '媒体凭据' : '语言模型凭据'}
                title="无法加载凭据列表"
                description={
                  typeof error === 'string'
                    ? `${error}。请检查后端服务状态后重试。`
                    : '加载凭据数据时出现问题，可能是服务暂时不可用。请稍后重试。'
                }
                action={onRetry ? <Button variant="secondary" onClick={onRetry}>刷新重试</Button> : undefined}
              />
            </TableStateRow>
          ) : credentials.length > 0 ? (
            credentials.map((c) => {
              const pluginKey = credentialPluginKey(c)
              const linked = linkedModels[c.id] || []
              const hasSecret = Boolean(c.hasApiKey || c.hasCredential)
              return (
                <TableRow key={c.id}>
                  <TableCell tone="strong">
                    <Button variant="ghost" size="sm" className="max-w-full whitespace-normal break-words text-left" onClick={() => setDetailCredential(c)} aria-label={`查看凭据 ${c.displayName} 详情`}>{c.displayName}</Button>
                    <div className="font-mono text-xs font-normal tabular-nums text-muted-foreground">
                      最近测试：{TEST_STATUS_LABEL[c.lastTestStatus] || c.lastTestStatus}
                      {c.lastTestErrorCode ? `（${c.lastTestErrorCode}）` : ''}
                    </div>
                  </TableCell>
                  <TableCell tone="muted">
                    <div className="flex min-w-0 flex-col gap-1">
                      {variant === 'media' && <span className="break-all font-mono text-xs">{pluginKey || '无来源插件'}</span>}
                      <span className="break-words font-mono text-xs">{c.providerId || c.adapter || '—'}</span>
                      {variant === 'language' && <span className="text-xs">{linked.length ? `关联 ${linked.length} 个模型` : '未关联模型'}</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={hasSecret ? 'success' : 'danger'}>{hasSecret ? '已配置密钥' : '未设置密钥'}</Badge>
                  </TableCell>
                  {/* Immediate setting: `Switch` reverts itself when the PATCH rejects,
                      and the failure message above surfaces the reason. */}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={c.enabled}
                        disabled={actions.isToggleBlocked(c.id, c.lastTestStatus === 'pending')}
                        onCheckedChange={(enabled) => toggleCredential(c, enabled)}
                        aria-label={`凭据 ${c.displayName} 启用状态`}
                      />
                      <span className="text-xs text-muted-foreground">
                        {c.enabled ? '已启用' : '已停用'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                          {/* `loading` keeps the label and the measured idle width, so the
                              row never reflows mid-test. */}
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={c.lastTestStatus === 'pending'}
                            disabled={credentialBusy(c)}
                            onClick={() => { void handleTest(c).catch(() => {}) }}
                            aria-label={`连通测试凭据 ${c.displayName}`}
                          >
                            连通测试
                          </Button>
                          <IconButton
                    className="min-h-[var(--control-md)] min-w-[var(--control-md)]"
                            variant="danger-ghost"
                            size="sm"
                            disabled={credentialBusy(c)}
                            onClick={() => requestDeleteCredential(c)}
                            aria-label={`删除凭据 ${c.displayName}`}
                            icon={<Trash2 weight="bold" aria-hidden="true" />}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              ) : (
                <TableStateRow>
                  <EmptyState
                    variant="first-use"
                    density="compact"
                    objectName={variant === 'media' ? '媒体凭据' : '语言模型凭据'}
                    title={variant === 'media' ? '还没有媒体凭据' : '还没有语言模型凭据'}
                    description={emptyText}
                  />
                </TableStateRow>
              )}
        </TableBody>
      </DataTable>
      <AdminRecordDetailDialog open={currentDetailCredential !== null || deleteTarget !== null} onClose={() => { setDetailCredential(null); setDeleteTarget(null) }} title="凭据详情"
        listFocusRef={recordListRef}
        confirmation={deleteTarget ? {
          objectName: `${deleteTarget.displayName}（${deleteTarget.id}）`,
          impact: (linkedModels[deleteTarget.id]?.length ?? 0) > 0
            ? `当前关联模型：${linkedModels[deleteTarget.id].join('、')}。删除可能影响这些模型的调用；引用限制由服务端校验。密钥删除后无法恢复。`
            : '当前列表未发现关联模型；引用限制仍由服务端校验。密钥删除后无法恢复。',
          pending: actions.isPending(deleteTarget.id),
          error: actions.errors[deleteTarget.id],
          cancelLabel: currentDetailCredential ? '返回详情' : '取消',
          onCancel: () => setDeleteTarget(null),
          onConfirm: () => {
            if (!deleteTarget || actions.isPending(deleteTarget.id)) return
            const target = deleteTarget
            void actions.run(target.id, target.displayName, () => deleteMutation.mutateAsync(target.id), '凭据已删除', 'delete')
              .then(() => {
                setDeleteTarget((current) => current?.id === target.id ? null : current)
                setDetailCredential((current) => current?.id === target.id ? null : current)
              }).catch(() => {})
          },
        } : undefined}
        actions={currentDetailCredential && <>
          <Switch checked={currentDetailCredential.enabled} disabled={actions.isToggleBlocked(currentDetailCredential.id, currentDetailCredential.lastTestStatus === 'pending')}
            onCheckedChange={(enabled) => toggleCredential(currentDetailCredential, enabled)} aria-label={`凭据 ${currentDetailCredential.displayName} 启用状态`} />
          <span>启用凭据</span>
          <Button variant="secondary" loading={currentDetailCredential.lastTestStatus === 'pending'} disabled={credentialBusy(currentDetailCredential)}
            onClick={() => { void handleTest(currentDetailCredential).catch(() => {}) }}>连通测试</Button>
        </>}
        danger={currentDetailCredential && <Button variant="danger-ghost" disabled={credentialBusy(currentDetailCredential)} onClick={() => requestDeleteCredential(currentDetailCredential)}>删除凭据</Button>}>
        {currentDetailCredential && <>
          <AdminRecordFields fields={[
            { label: '凭据名称', value: currentDetailCredential.displayName },
            { label: '凭据 ID', value: <span className="font-mono">{currentDetailCredential.id}</span> },
            { label: '来源插件', value: credentialPluginKey(currentDetailCredential) || '自定义凭据' },
            { label: '供应商账号', value: currentDetailCredential.providerId || currentDetailCredential.adapter || '—' },
            { label: 'Base URL', value: <span className="font-mono">{currentDetailCredential.baseUrl || '—'}</span> },
            { label: '关联模型', value: linkedModels[currentDetailCredential.id]?.join('、') || '未关联模型' },
            { label: '密钥状态', value: currentDetailCredential.hasApiKey || currentDetailCredential.hasCredential ? '已配置密钥' : '未设置密钥' },
            { label: '状态', value: currentDetailCredential.enabled ? '已启用' : '已停用' },
            { label: '最近测试', value: TEST_STATUS_LABEL[currentDetailCredential.lastTestStatus] || currentDetailCredential.lastTestStatus },
            { label: '最近测试错误代码', value: currentDetailCredential.lastTestErrorCode || '—' },
          ]} />
          <AdminActionErrors errors={actions.errors[currentDetailCredential.id] ? { [currentDetailCredential.id]: actions.errors[currentDetailCredential.id] } : {}} />
        </>}
      </AdminRecordDetailDialog>
    </div>
  )
}
