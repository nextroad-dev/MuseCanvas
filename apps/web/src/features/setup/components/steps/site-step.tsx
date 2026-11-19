'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SetupConfigDto } from '@musecanvas/contracts'

import { Alert, Badge, Button, Field, Input } from '@/shared/components/ui'
import { clientApi } from '@/shared/services/client-api'
import { describeSetupError, isSetupSessionError } from '../../lib/setup-errors'
import { siteDraftFromDto, toSiteInput, validateSiteDraft } from '../../lib/setup-forms'
import type { SiteDraft } from '../../lib/setup-forms'
import { SetupStepShell } from '../setup-step-shell'

export interface SiteStepProps {
  config: SetupConfigDto
  /** 服务端 site 段是否已完成。 */
  complete: boolean
  onDone: () => void | Promise<void>
  onSessionLost: (message: string) => void
}

/** 站点信息：本站名称与公开访问 origin（影响邮件链接、OAuth 回调与签名 URL 的 origin）。 */
export function SiteStep({ config, complete, onDone, onSessionLost }: SiteStepProps) {
  const [draft, setDraft] = useState<SiteDraft>(() => siteDraftFromDto(config.site))
  const [errors, setErrors] = useState<Partial<Record<keyof SiteDraft, string>>>({})
  const [notice, setNotice] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => clientApi.setup.updateSite(toSiteInput(draft)),
    onSuccess: async () => {
      setNotice(null)
      await onDone()
    },
    onError: (error: unknown) => {
      if (isSetupSessionError(error)) {
        onSessionLost(describeSetupError(error, '初始化会话已失效。'))
        return
      }
      setNotice(describeSetupError(error, '保存站点信息失败，请稍后重试。'))
    },
  })

  const saved = config.site.revision > 0

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (save.isPending) return
    const next = validateSiteDraft(draft)
    setErrors(next)
    setNotice(null)
    if (Object.keys(next).length > 0) return
    save.mutate()
  }

  return (
    <SetupStepShell
      headingId="setup-site-title"
      title="站点信息"
      description="站点名称用于页面标题与邮件署名；公开地址用于邮件链接、OAuth 回调与分享地址。"
      status={<Badge tone={complete ? 'success' : 'neutral'}>{complete ? '已完成' : saved ? '待确认' : '待配置'}</Badge>}
    >
      {notice ? (
        <Alert tone="danger" role="alert" title="无法保存站点信息">
          {notice}
        </Alert>
      ) : null}

      <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
        <Field
          id="setup-site-name"
          label="站点名称"
          required
          error={errors.siteName}
          hint="显示在浏览器标题与邮件里，最多 120 个字符。"
        >
          <Input
            size="md"
            value={draft.siteName}
            disabled={save.isPending}
            placeholder="MuseCanvas"
            onChange={(event) => {
              setDraft((previous) => ({ ...previous, siteName: event.target.value }))
              setErrors((previous) => ({ ...previous, siteName: undefined }))
              if (notice) setNotice(null)
            }}
          />
        </Field>

        <Field
          id="setup-site-url"
          label="公开访问地址"
          error={errors.siteUrl}
          hint="可选，例如 https://canvas.example.com。必须是 HTTPS origin（本地开发可用 localhost 的 HTTP），不能带路径。"
        >
          <Input
            type="url"
            size="md"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={draft.siteUrl}
            disabled={save.isPending}
            placeholder="https://canvas.example.com"
            onChange={(event) => {
              setDraft((previous) => ({ ...previous, siteUrl: event.target.value }))
              setErrors((previous) => ({ ...previous, siteUrl: undefined }))
              if (notice) setNotice(null)
            }}
          />
        </Field>

        <div>
          <Button type="submit" size="md" loading={save.isPending}>
            保存并继续
          </Button>
        </div>
      </form>
    </SetupStepShell>
  )
}
