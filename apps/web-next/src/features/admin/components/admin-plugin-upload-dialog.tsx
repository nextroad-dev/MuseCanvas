'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  AdminPluginScanFinding,
  AdminPluginUploadResponse,
  AdminPluginValidateSuccess,
  PluginKind,
} from '@/shared/types'
import { PLUGIN_PACKAGE_MAX_BYTES, humanFileSize, postPluginPackage, shortDigest } from '../lib/plugin-upload'
import { PluginFindingList } from './plugin-finding-list'
import { ShieldAlert } from 'lucide-react'
import {
  Alert,
  Button,
  Dialog,
  FileDropZone,
  Spinner,
} from '@/shared/components/ui'
import type { DropZoneFile } from '@/shared/components/ui'

/** The drop zone holds at most one package; a stable id keeps its row keyed. */
const PACKAGE_FILE_ID = 'plugin-package'

/** Mirrors PLUGIN_PACKAGE_MAX_BYTES (6 MiB) for copy; the server enforces the cap. */
const PACKAGE_MAX_LABEL = '6 MiB'

/** Debounce rapid re-selection so only the last picked package is validated. */
const VALIDATE_DEBOUNCE_MS = 400

type ValidatePhase = 'idle' | 'checking' | 'ready' | 'rejected' | 'error'

interface ValidateState {
  phase: ValidatePhase
  findings: AdminPluginScanFinding[]
  summary: AdminPluginValidateSuccess | null
  message: string
}

const IDLE: ValidateState = { phase: 'idle', findings: [], summary: null, message: '' }

interface AdminPluginUploadDialogProps {
  open: boolean
  onClose: () => void
  /** Which kernel the section belongs to; only used for the dialog title (the package's manifest.json decides the real kind). */
  kind: PluginKind
  /** Called after a successful install so the parent can announce the `待加载` handshake. */
  onInstalled?: (plugin: { pluginId: string; pluginVersion: string }) => void
}

export function AdminPluginUploadDialog({ open, onClose, kind, onInstalled }: AdminPluginUploadDialogProps) {
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [validate, setValidate] = useState<ValidateState>(IDLE)

  const resetFields = () => {
    setFile(null)
    setValidate(IDLE)
  }

  const close = () => {
    resetFields()
    onClose()
  }

  // Pre-flight: whenever a package is selected, run POST admin/plugins/validate
  // (scan-only, writes nothing) so the admin sees findings before installing. Stale responses
  // are dropped via the AbortController owned by this effect run.
  useEffect(() => {
    if (!open) return
    if (!file) {
      setValidate(IDLE)
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setValidate({ ...IDLE, phase: 'error', message: '插件包必须是单个 .zip 文件（服务端同样强制）' })
      return
    }
    if (file.size > PLUGIN_PACKAGE_MAX_BYTES) {
      setValidate({
        ...IDLE,
        phase: 'error',
        message: `插件包不能超过 ${PLUGIN_PACKAGE_MAX_BYTES.toLocaleString('en-US')} 字节（${PACKAGE_MAX_LABEL}，上限由服务端强制），当前为 ${humanFileSize(file.size)}`,
      })
      return
    }
    const controller = new AbortController()
    setValidate({ ...IDLE, phase: 'checking' })
    const timer = setTimeout(async () => {
      const res = await postPluginPackage<AdminPluginValidateSuccess | { ok: false; installed: false; code: string; findings: AdminPluginScanFinding[] }>(
        API_ENDPOINTS.admin.pluginValidate,
        file,
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (!res.success) {
        setValidate({ ...IDLE, phase: 'error', message: `${res.error?.code ?? 'ERROR'}：${res.error?.message ?? '校验请求失败'}` })
        return
      }
      const data = res.data
      if (data && data.ok === true) {
        setValidate({ phase: 'ready', findings: data.warnings, summary: data, message: '' })
      } else if (data) {
        // HTTP 422 arrives with a success:true envelope (server `rejected()` wraps `ok()`),
        // so findings live on res.data, not res.error.
        setValidate({ phase: 'rejected', findings: data.findings, summary: null, message: `服务端拒绝：${data.code}` })
      } else {
        setValidate({ ...IDLE, phase: 'error', message: '校验响应缺少数据' })
      }
    }, VALIDATE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, file])

  const installMutation = useMutation({
    mutationFn: async (pkg: File) =>
      postPluginPackage<AdminPluginUploadResponse>(API_ENDPOINTS.admin.pluginUpload, pkg),
    onSuccess: (res) => {
      if (!res.success) {
        // fail() envelope: PLUGIN_UPLOAD_DISABLED / PLUGIN_VERSION_IMMUTABLE /
        // PLUGIN_ID_RESERVED / INVALID_INPUT / PLUGIN_ARTIFACT_TOO_LARGE / NETWORK_ERROR…
        setValidate({ ...IDLE, phase: 'error', message: `${res.error?.code ?? 'ERROR'}：${res.error?.message ?? '上传请求失败'}` })
        return
      }
      const data = res.data
      if (data && data.installed === true) {
        // The row was created with status='pending'; it goes live only after the
        // worker pulls, verifies and re-scans the artifact on its maintenance tick.
        queryClient.invalidateQueries({ queryKey: ['admin', 'plugins'] })
        onInstalled?.({ pluginId: data.plugin.pluginId, pluginVersion: data.plugin.pluginVersion })
        close()
        return
      }
      if (data) {
        setValidate({ phase: 'rejected', findings: data.findings, summary: null, message: `服务端拒绝：${data.code}` })
      } else {
        setValidate({ ...IDLE, phase: 'error', message: '上传响应缺少数据' })
      }
    },
    onError: (err: Error) => {
      setValidate({ ...IDLE, phase: 'error', message: err.message || '上传请求失败' })
    },
  })

  const blockingFindings = validate.findings.some((f) => f.severity === 'error')
  const canSubmit =
    !!file &&
    (validate.phase === 'ready' || validate.phase === 'rejected') &&
    !blockingFindings &&
    !installMutation.isPending

  // One selected package, mirrored into the shared drop zone's file row. No byte
  // progress is available from `postPluginPackage`, so no percentage is claimed:
  // the install button carries the busy state instead.
  const packageFiles: DropZoneFile[] = file
    ? [{ id: PACKAGE_FILE_ID, name: file.name, size: file.size }]
    : []

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`上传${kind === 'media' ? '媒体' : '语言'}插件`}
      panelClassName="max-w-dialog-wide"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button
            loading={installMutation.isPending}
            disabled={!canSubmit}
            onClick={() => file && installMutation.mutate(file)}
          >
            安装插件
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Risk disclosure — deliberately first-class content, not fine print. */}
        <Alert
          tone="danger"
          icon={<ShieldAlert aria-hidden="true" />}
          title="上传前必读"
        >
          <div className="flex flex-col gap-2">
            <p>
              上传的插件代码会由 Worker 进程<strong>以该进程的全部权限直接执行</strong>（可读写任务数据、访问已配置的供应商凭据与网络）。
              仅允许受信任的管理员上传，请勿加载任何来源不明的插件包。
            </p>
            <p>
              <strong>同版本不可覆盖，升级版本号后重新上传</strong>：插件以 <code className="font-mono">pluginId@pluginVersion</code>{' '}
              为一次性写入身份（取自包内 <code className="font-mono">manifest.json</code> 的 id / version），Worker 的注册表与模块缓存都以该身份为键，同版本热替换不会生效，服务端会直接拒绝（PLUGIN_VERSION_IMMUTABLE）。
            </p>
          </div>
        </Alert>

        <FileDropZone
          files={packageFiles}
          onFilesSelected={(files) => setFile(files[0] ?? null)}
          onRemove={() => setFile(null)}
          accept=".zip,application/zip"
          maxFileSize={PLUGIN_PACKAGE_MAX_BYTES}
          maxFiles={1}
          label="拖拽 .zip 插件包到此处，或点击选择文件"
          hint={`单个 .zip 文件，大小上限 ${PACKAGE_MAX_LABEL}（${PLUGIN_PACKAGE_MAX_BYTES.toLocaleString('en-US')} 字节），以服务端强制为准。`}
        />

        <div className="flex flex-col gap-1 rounded-control bg-tonal p-3 text-xs text-muted-foreground">
          <p>
            插件包须在根目录（或唯一一层顶级目录）包含 <code className="font-mono text-foreground">manifest.json</code> 与其{' '}
            <code className="font-mono text-foreground">package.entry</code> 指向的单个 <code className="font-mono text-foreground">.mjs</code>{' '}
            入口；可选附带 <code className="font-mono text-foreground">README.md</code>、<code className="font-mono text-foreground">CHANGELOG.md</code>、
            <code className="font-mono text-foreground">LICENSE</code> 与 PNG / WebP 图标。
          </p>
          <p>清单只从包内 manifest.json 读取，无需另行填写；字段规则由服务端校验。</p>
        </div>

        {/* aria-live region: pre-flight verdict + findings update without a click. */}
        <div aria-live="polite" role="status" className="flex flex-col gap-2">
          {validate.phase === 'checking' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner label="正在校验" />
              正在服务端解包并扫描插件包（不落库）…
            </p>
          )}
          {validate.phase === 'error' && (
            <Alert tone="danger" role="alert" title="无法完成预检">
              {validate.message}。请更换插件包文件或修正包内 manifest.json 后重试。
            </Alert>
          )}
          {validate.phase === 'rejected' && (
            <div className="flex flex-col gap-2">
              <Alert tone="danger" role="alert" title="服务端拒绝该插件包">
                {validate.message}。请按下列发现（按包内文件分组）修正后，以新的版本号重新上传。
              </Alert>
              <PluginFindingList findings={validate.findings} groupByPath />
            </div>
          )}
          {validate.phase === 'ready' && validate.summary && (
            <div className="flex flex-col gap-2">
              <Alert tone="success" title="校验通过">
                插件包已通过服务端扫描，可以安装插件。
              </Alert>
              <div className="flex flex-col gap-1 rounded-control bg-tonal p-3 text-xs text-muted-foreground">
                <span className="font-mono text-foreground">
                  {validate.summary.pluginId}@{validate.summary.pluginVersion}
                </span>
                <span>
                  {validate.summary.displayName} · {validate.summary.modelIds.length} 个模型 · 入口制品 sha256{' '}
                  <span className="font-mono text-foreground" title={validate.summary.artifactDigest}>
                    {shortDigest(validate.summary.artifactDigest)}
                  </span>{' '}
                  · {humanFileSize(validate.summary.artifactSizeBytes)}
                </span>
              </div>
              {validate.summary.warnings.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">警告（不阻断安装，但请确认符合预期）：</p>
                  <PluginFindingList findings={validate.summary.warnings} groupByPath />
                </div>
              )}
            </div>
          )}
          {validate.phase === 'idle' && (
            <p className="text-xs text-muted-foreground">选择 .zip 插件包后将自动进行服务端预检。</p>
          )}
        </div>

        {blockingFindings && (
          <Alert tone="danger" role="alert" title="无法安装插件">
            存在错误级别的扫描发现，安装已被阻止。请按下列发现修正插件包后重新上传。
          </Alert>
        )}

        <p className="text-xs text-muted-foreground">
          安装成功后插件状态为「待加载」：需等待 Worker 拉取制品、核验 sha256 并重新扫描通过后才会启用，安装完成不代表即时生效。
        </p>
      </div>
    </Dialog>
  )
}
