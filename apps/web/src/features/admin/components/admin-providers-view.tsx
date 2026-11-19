'use client'

import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowClockwiseIcon,
  KeyIcon,
  PencilSimpleIcon,
  PlugsConnectedIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'

import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FieldGroup,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  Textarea,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import type { BadgeTone, SegmentedControlItem } from '@/shared/components/ui'
import {
  useAdminProviderCredentials,
  useAdminProviderTemplates,
  useCreateProviderCredential,
  useDeleteProviderCredential,
  useTestProviderCredential,
  useUpdateProviderCredential,
} from '@/shared/hooks/useAdmin'
import { formatDateTime } from '@/shared/lib/format'
import { isApiError } from '@/shared/services/client-api'
import type {
  BuiltinProviderTemplate,
  ProviderCredentialDto,
  ProviderCredentialInput,
  ProviderTestStatus,
} from '@/shared/types'

type SecretFormat = 'text' | 'json'

const SECRET_FORMAT_ITEMS: SegmentedControlItem<SecretFormat>[] = [
  { value: 'text', label: 'API Key 文本' },
  { value: 'json', label: 'JSON 服务账号凭据' },
]

function testStatusLabel(status: ProviderTestStatus): string {
  switch (status) {
    case 'success':
      return '连通正常'
    case 'failed':
      return '探测失败'
    case 'pending':
      return '探测中'
    case 'not_tested':
      return '未测试'
  }
}

function testStatusTone(status: ProviderTestStatus): BadgeTone {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
      return 'danger'
    case 'pending':
      return 'info'
    case 'not_tested':
      return 'neutral'
  }
}

function baseUrlPolicyHint(policy?: 'fixed' | 'allowlisted' | 'any-https'): string {
  switch (policy) {
    case 'fixed':
      return '该供应商使用固定官方端点地址（fixed），不可修改。'
    case 'allowlisted':
      return '仅允许插件白名单内的安全域名（allowlisted）。'
    case 'any-https':
      return '支持自定义兼容的 HTTPS 代理或网关地址（any-https）。'
    default:
      return '留空则回退到供应商模板默认地址。'
  }
}

function formatCredentialError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'CREDENTIAL_IN_USE') {
      return '该凭据正被一个或多个模型配置引用，请先在「模型配置」中解绑后再删除（409 CREDENTIAL_IN_USE）。'
    }
    if (error.code === 'SECRET_REQUIRED_FOR_REDIRECT') {
      return '修改接口域名或供应商标识时，出于安全防泄漏要求必须重新输入密钥（422 SECRET_REQUIRED_FOR_REDIRECT）。'
    }
    return `${error.message} (${error.code})`
  }
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

export function AdminProvidersView() {
  const { toast } = useToast()

  const credentialsQuery = useAdminProviderCredentials()
  const templatesQuery = useAdminProviderTemplates()

  const createMutation = useCreateProviderCredential()
  const updateMutation = useUpdateProviderCredential()
  const deleteMutation = useDeleteProviderCredential()
  const testMutation = useTestProviderCredential()

  const [testingId, setTestingId] = useState<string | null>(null)

  // 创建 / 编辑弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCredential, setEditingCredential] = useState<ProviderCredentialDto | null>(null)
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [providerId, setProviderId] = useState('')
  const [pluginId, setPluginId] = useState('')
  const [pluginVersion, setPluginVersion] = useState('')
  const [schemaId, setSchemaId] = useState('')
  const [schemaVersion, setSchemaVersion] = useState('1')
  const [baseUrl, setBaseUrl] = useState('')
  const [secretFormat, setSecretFormat] = useState<SecretFormat>('text')
  const [secretText, setSecretText] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)

  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = useState<ProviderCredentialDto | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const credentials = useMemo(() => credentialsQuery.data ?? [], [credentialsQuery.data])
  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data])

  const selectedTemplate = useMemo<BuiltinProviderTemplate | undefined>(
    () => templates.find((t) => t.key === selectedTemplateKey),
    [templates, selectedTemplateKey],
  )

  function applyTemplate(template: BuiltinProviderTemplate) {
    setSelectedTemplateKey(template.key)
    setProviderId(template.providerId)
    setPluginId(template.pluginId)
    setPluginVersion(template.pluginVersion)
    setSchemaId(template.credential.schemaId)
    setSchemaVersion(String(template.credential.schemaVersion))
    setBaseUrl(template.baseUrl)
    setSecretFormat(template.credential.format)
    if (!displayName.trim()) {
      setDisplayName(template.displayName)
    }
  }

  function openCreateDialog() {
    setEditingCredential(null)
    setFormError(null)
    setSecretText('')
    setEnabled(true)

    const firstTemplate = templates[0]
    if (firstTemplate) {
      setSelectedTemplateKey(firstTemplate.key)
      setDisplayName(firstTemplate.displayName)
      setProviderId(firstTemplate.providerId)
      setPluginId(firstTemplate.pluginId)
      setPluginVersion(firstTemplate.pluginVersion)
      setSchemaId(firstTemplate.credential.schemaId)
      setSchemaVersion(String(firstTemplate.credential.schemaVersion))
      setBaseUrl(firstTemplate.baseUrl)
      setSecretFormat(firstTemplate.credential.format)
    } else {
      setSelectedTemplateKey('')
      setDisplayName('')
      setProviderId('')
      setPluginId('')
      setPluginVersion('')
      setSchemaId('bearer_api_key')
      setSchemaVersion('1')
      setBaseUrl('')
      setSecretFormat('text')
    }
    setDialogOpen(true)
  }

  function openEditDialog(cred: ProviderCredentialDto) {
    setEditingCredential(cred)
    setFormError(null)
    setDisplayName(cred.displayName)
    setProviderId(cred.providerId ?? '')
    setSchemaId(cred.schemaId)
    setSchemaVersion(String(cred.schemaVersion))
    setBaseUrl(cred.baseUrl)
    setSecretText('')
    setEnabled(cred.enabled)

    const matchedTemplate = templates.find(
      (t) =>
        t.providerId === cred.providerId &&
        t.credential.schemaId === cred.schemaId,
    )
    setSelectedTemplateKey(matchedTemplate?.key ?? '')
    setPluginId(matchedTemplate?.pluginId ?? '')
    setPluginVersion(matchedTemplate?.pluginVersion ?? '')
    setSecretFormat(
      matchedTemplate?.credential.format ??
        (cred.schemaId.includes('service_account') || cred.schemaId.includes('json') ? 'json' : 'text'),
    )
    setDialogOpen(true)
  }

  async function handleTestCredential(cred: ProviderCredentialDto) {
    setTestingId(cred.id)
    try {
      const result = await testMutation.mutateAsync(cred.id)
      if (result.status === 'success') {
        toast.success('连通性探测成功', `凭据「${cred.displayName}」响应正常。`)
      } else {
        toast.info(
          '连通性探测已受理 (202 Pending)',
          `「${cred.displayName}」远端探测耗时较长，后台正在继续验证，请稍后刷新查看结果。`,
        )
      }
    } catch (error) {
      toast.error('连通性探测失败', formatCredentialError(error))
    } finally {
      setTestingId(null)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    if (!displayName.trim()) {
      setFormError('请输入凭据显示名称。')
      return
    }

    let parsedSecret: string | Record<string, unknown> | undefined
    const trimmedSecret = secretText.trim()

    if (!editingCredential && !trimmedSecret) {
      setFormError('创建凭据时必须填写密钥内容。')
      return
    }

    if (trimmedSecret) {
      if (secretFormat === 'json') {
        try {
          const parsed = JSON.parse(trimmedSecret) as unknown
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            setFormError('JSON 凭据必须是一个有效的 JSON 对象。')
            return
          }
          parsedSecret = parsed as Record<string, unknown>
        } catch {
          setFormError('JSON 凭据格式无效，请检查括号与引号是否完整。')
          return
        }
      } else {
        parsedSecret = trimmedSecret
      }
    }

    const parsedSchemaVersion = Number.parseInt(schemaVersion, 10)

    try {
      if (editingCredential) {
        const input: ProviderCredentialInput = {
          displayName: displayName.trim(),
          ...(providerId.trim() ? { providerId: providerId.trim() } : {}),
          baseUrl: baseUrl.trim() ? baseUrl.trim() : null,
          enabled,
          ...(parsedSecret !== undefined ? { secret: parsedSecret } : {}),
        }
        await updateMutation.mutateAsync({ id: editingCredential.id, input })
        toast.success('凭据已更新', `「${displayName.trim()}」修改已保存。`)
        setDialogOpen(false)
      } else {
        const input: ProviderCredentialInput = {
          displayName: displayName.trim(),
          ...(providerId.trim() ? { providerId: providerId.trim() } : {}),
          ...(pluginId.trim() ? { pluginId: pluginId.trim() } : {}),
          ...(pluginVersion.trim() ? { pluginVersion: pluginVersion.trim() } : {}),
          ...(schemaId.trim() ? { schemaId: schemaId.trim() } : {}),
          ...(Number.isFinite(parsedSchemaVersion) ? { schemaVersion: parsedSchemaVersion } : {}),
          baseUrl: baseUrl.trim() ? baseUrl.trim() : null,
          secret: parsedSecret,
          enabled,
        }
        const created = await createMutation.mutateAsync(input)
        toast.success('供应商凭据已创建', `已添加「${created.displayName}」。`)
        setDialogOpen(false)
      }
    } catch (error) {
      const message = formatCredentialError(error)
      setFormError(message)
      toast.error(editingCredential ? '更新凭据失败' : '创建凭据失败', message)
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleteError(null)
    try {
      await deleteMutation.mutateAsync(deleteTarget.id)
      toast.success('凭据已删除', `「${deleteTarget.displayName}」已移除。`)
      setDeleteTarget(null)
    } catch (error) {
      const message = formatCredentialError(error)
      setDeleteError(message)
      toast.error('删除凭据失败', message)
    }
  }

  const isSubmitting = createMutation.isPending || updateMutation.isPending
  const isBaseUrlFixed = selectedTemplate?.credential.baseUrlPolicy === 'fixed'

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="供应商凭据"
        description="集中管理外部模型供应商 API 密钥与接口地址，支持实时连通性探测。"
        actions={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => void credentialsQuery.refetch()}
              loading={credentialsQuery.isFetching}
              leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={openCreateDialog}
              leadingIcon={<PlusIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              新增凭据
            </Button>
          </>
        }
      />

      {credentialsQuery.isError ? (
        <Alert
          tone="danger"
          title="供应商凭据加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void credentialsQuery.refetch()}>
              重试
            </Button>
          }
        >
          {formatCredentialError(credentialsQuery.error)}
        </Alert>
      ) : null}

      <DataTable caption="供应商凭据列表" columns={6} className="[&>table]:min-w-[900px]">
        <TableHeader>
          <TableHeadCell>凭据名称</TableHeadCell>
          <TableHeadCell>接口地址</TableHeadCell>
          <TableHeadCell>密钥状态</TableHeadCell>
          <TableHeadCell>最近探测</TableHeadCell>
          <TableHeadCell>启用状态</TableHeadCell>
          <TableHeadCell align="right">操作</TableHeadCell>
        </TableHeader>
        <TableBody busy={credentialsQuery.isFetching}>
          {credentialsQuery.isPending ? (
            Array.from({ length: 4 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <Skeleton key="name" className="h-5 w-40" />,
                  <Skeleton key="url" className="h-4 w-48" />,
                  <Skeleton key="key" className="h-5 w-28" />,
                  <Skeleton key="test" className="h-5 w-36" />,
                  <Skeleton key="status" className="h-5 w-16" />,
                  <Skeleton key="actions" className="ml-auto h-8 w-36" />,
                ]}
              />
            ))
          ) : credentials.length === 0 ? (
            <TableStateRow>
              <EmptyState
                density="compact"
                icon={KeyIcon}
                title="尚未配置任何供应商凭据"
                description="添加 OpenAI、Google Vertex、DashScope 等供应商密钥后，即可在模型配置中绑定调用。"
                action={
                  <Button variant="primary" size="sm" onClick={openCreateDialog}>
                    新增凭据
                  </Button>
                }
              />
            </TableStateRow>
          ) : (
            credentials.map((cred) => {
              const isTestingThis = testingId === cred.id && testMutation.isPending
              return (
                <TableRow key={cred.id} hover>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">{cred.displayName}</span>
                      <span className="font-mono text-caption text-muted-foreground">
                        {cred.providerId || cred.adapter || 'custom'} · {cred.schemaId}@v
                        {cred.schemaVersion}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell>
                    <span className="break-all font-mono text-caption text-foreground">
                      {cred.baseUrl || '—'}
                    </span>
                  </TableCell>

                  <TableCell>
                    {cred.hasCredential ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone="success">已配置</Badge>
                        {cred.keyFingerprint ? (
                          <span className="font-mono text-caption text-muted-foreground">
                            {cred.keyFingerprint}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <Badge tone="warning">未配置</Badge>
                    )}
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={testStatusTone(cred.lastTestStatus)}>
                          {testStatusLabel(cred.lastTestStatus)}
                        </Badge>
                        {cred.lastTestErrorCode ? (
                          <span className="font-mono text-caption text-danger">
                            {cred.lastTestErrorCode}
                          </span>
                        ) : null}
                      </div>
                      {cred.lastTestedAt ? (
                        <span className="font-mono text-caption text-muted-foreground">
                          {formatDateTime(cred.lastTestedAt)}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>

                  <TableCell>
                    <Badge tone={cred.enabled ? 'success' : 'neutral'} dot>
                      {cred.enabled ? '已启用' : '已停用'}
                    </Badge>
                  </TableCell>

                  <TableCell align="right">
                    <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={isTestingThis}
                        onClick={() => void handleTestCredential(cred)}
                        leadingIcon={
                          <PlugsConnectedIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                        }
                      >
                        测试连通性
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditDialog(cred)}
                        leadingIcon={
                          <PencilSimpleIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                        }
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:bg-danger-soft hover:text-danger"
                        onClick={() => {
                          setDeleteError(null)
                          setDeleteTarget(cred)
                        }}
                        leadingIcon={<TrashIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
                      >
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </DataTable>

      {/* 新增 / 编辑凭据弹窗 */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        size="wide"
        title={editingCredential ? `编辑凭据：${editingCredential.displayName}` : '新增供应商凭据'}
        description={
          editingCredential
            ? '密钥为只写加密字段，留空表示保留原密钥不变。'
            : '选择供应商模板以自动填充契约参数与默认接口地址，也可手动填写自定义凭据。'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)} disabled={isSubmitting}>
              取消
            </Button>
            <Button type="submit" form="admin-provider-form" variant="primary" loading={isSubmitting}>
              {editingCredential ? '保存修改' : '确认创建'}
            </Button>
          </>
        }
      >
        <form id="admin-provider-form" onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
          {formError ? (
            <Alert tone="danger" role="alert" title="无法保存供应商凭据">
              {formError}
            </Alert>
          ) : null}

          <FieldGroup>
            {!editingCredential ? (
              <Field
                label="供应商模板"
                hint={
                  selectedTemplate?.description ||
                  '选择模板将自动填入供应商 ID、插件版本、凭据 Schema 与默认接口地址。'
                }
              >
                <Select
                  value={selectedTemplateKey}
                  onChange={(event) => {
                    const key = event.target.value
                    setSelectedTemplateKey(key)
                    const found = templates.find((t) => t.key === key)
                    if (found) applyTemplate(found)
                  }}
                >
                  <option value="">自定义手动配置…</option>
                  {templates.map((tpl) => (
                    <option key={tpl.key} value={tpl.key}>
                      {tpl.displayName} ({tpl.providerId} · {tpl.modality === 'video' ? '视频' : '图像'})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="凭据显示名称" required hint="用于在模型配置下拉列表中识别该密钥。">
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="例如 OpenAI 生产主密钥"
                  required
                />
              </Field>

              <Field label="供应商标识 (providerId)" required>
                <Input
                  value={providerId}
                  onChange={(event) => setProviderId(event.target.value)}
                  placeholder="例如 openai / google / dashscope"
                  disabled={Boolean(!editingCredential && selectedTemplate)}
                  required
                />
              </Field>
            </div>

            {!editingCredential && !selectedTemplate ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="凭据 Schema ID" required>
                  <Input
                    value={schemaId}
                    onChange={(event) => setSchemaId(event.target.value)}
                    placeholder="例如 bearer_api_key"
                    required
                  />
                </Field>
                <Field label="Schema 版本" required>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={schemaVersion}
                    onChange={(event) => setSchemaVersion(event.target.value)}
                    required
                  />
                </Field>
              </div>
            ) : null}

            <Field
              label="接口地址 (baseUrl)"
              hint={baseUrlPolicyHint(selectedTemplate?.credential.baseUrlPolicy)}
            >
              <Input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={selectedTemplate?.baseUrl || 'https://api.openai.com/v1'}
                disabled={Boolean(isBaseUrlFixed && !editingCredential)}
              />
            </Field>

            {editingCredential ? (
              <Alert tone="info" title="安全重定向保护提示">
                如果修改了供应商标识（providerId）或接口地址的主机域名（baseUrl host），后端会要求重新输入完整密钥（422 SECRET_REQUIRED_FOR_REDIRECT），以防止原有密钥被转发至新域名。
              </Alert>
            ) : null}

            {!selectedTemplate ? (
              <Field label="密钥录入格式">
                <SegmentedControl
                  label="密钥录入格式"
                  items={SECRET_FORMAT_ITEMS}
                  value={secretFormat}
                  onChange={setSecretFormat}
                  size="sm"
                />
              </Field>
            ) : null}

            <Field
              label={
                selectedTemplate?.credential.label ||
                (secretFormat === 'json' ? '服务账号 JSON 凭据' : 'API 密钥 (Secret)')
              }
              required={!editingCredential}
              hint={
                editingCredential
                  ? '留空则保留当前已加密存储的密钥；输入新内容将覆盖原密钥。'
                  : selectedTemplate?.credential.helpText || '密钥仅在服务端使用 HKDF 主密钥加密落库，保存后不可明文回读。'
              }
            >
              {secretFormat === 'json' ? (
                <Textarea
                  rows={6}
                  className="font-mono text-xs"
                  value={secretText}
                  onChange={(event) => setSecretText(event.target.value)}
                  placeholder={
                    selectedTemplate?.credential.placeholder ||
                    '{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key": "..."\n}'
                  }
                  required={!editingCredential}
                />
              ) : (
                <Input
                  type="password"
                  autoComplete="new-password"
                  className="font-mono"
                  value={secretText}
                  onChange={(event) => setSecretText(event.target.value)}
                  placeholder={
                    editingCredential
                      ? editingCredential.keyFingerprint
                        ? `当前指纹：${editingCredential.keyFingerprint}（留空保持不变）`
                        : '留空保持原密钥不变'
                      : selectedTemplate?.credential.placeholder || 'sk-...'
                  }
                  required={!editingCredential}
                />
              )}
            </Field>

            <div className="flex items-center justify-between gap-4 rounded-card border border-border bg-canvas p-4">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-foreground">启用该供应商凭据</span>
                <span className="text-xs text-muted-foreground">
                  停用后绑定该凭据的模型将无法发起新的外部调用
                </span>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                aria-label="启用该供应商凭据"
              />
            </div>
          </FieldGroup>
        </form>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="确认删除供应商凭据"
        description={
          deleteTarget
            ? `即将永久删除凭据「${deleteTarget.displayName}」。该操作不可撤销。`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              onClick={() => void handleConfirmDelete()}
            >
              确认删除
            </Button>
          </>
        }
      >
        {deleteError ? (
          <Alert tone="danger" role="alert" title="无法删除该凭据">
            {deleteError}
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            请确认没有模型正在绑定此凭据；若有模型引用，后端将返回 409 CREDENTIAL_IN_USE 阻止删除。
          </p>
        )}
      </Dialog>
    </div>
  )
}
