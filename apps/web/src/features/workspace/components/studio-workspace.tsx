'use client'

import { Suspense, useEffect, useState, type MouseEvent } from 'react'
import { AgentConsoleView } from '@/features/agent-console/components/agent-console-view'
import {
  parseInspectorPanelQuery,
  parseReuseImageQuery,
} from '@/features/agent-console/lib/agent-console-reuse'
import { useAgentConsoleStore } from '@/features/agent-console/stores/agent-console-store'
import { LibraryView } from '@/features/library/components/library-view'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'

export interface StudioWorkspaceProps {
  mode: WorkspaceMode
  initialRoute: 'generate' | 'library'
}

/**
 * 工作台单页宿主：在 `/generate` 与 `/library` 之间提供零网络重刷、零整页重载的纯客户端即时切换，
 * 同时保持浏览器地址栏 URL、前进/后退历史栈与 `?prompt=` 复用参数同步。
 */
export function StudioWorkspace({ mode, initialRoute }: StudioWorkspaceProps) {
  const [route, setRoute] = useState<'generate' | 'library'>(initialRoute)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const syncFromLocation = () => {
      const pathname = window.location.pathname
      if (pathname === APP_ROUTES.library || pathname.startsWith(`${APP_ROUTES.library}/`)) {
        setRoute('library')
      } else if (pathname === APP_ROUTES.generate || pathname.startsWith(`${APP_ROUTES.generate}/`)) {
        const rawQuery = window.location.search.replace(/^\?/, '')
        useAgentConsoleStore.getState().consumeReuseQuery(rawQuery)
        setRoute('generate')
      }
    }
    window.addEventListener('popstate', syncFromLocation)
    return () => window.removeEventListener('popstate', syncFromLocation)
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = route === 'library' ? '作品图库 · MuseCanvas' : 'Agent 操作台 · MuseCanvas'
  }, [route])

  function handleClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      typeof window === 'undefined'
    ) {
      return
    }

    const target = event.target as Element | null
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) {
      return
    }

    let url: URL
    try {
      url = new URL(anchor.href, window.location.origin)
    } catch {
      return
    }

    if (url.origin !== window.location.origin) return

    const isGenerate = url.pathname === APP_ROUTES.generate
    const isLibrary = url.pathname === APP_ROUTES.library
    if (!isGenerate && !isLibrary) return

    event.preventDefault()
    event.stopPropagation()

    const nextHref = `${url.pathname}${url.search}${url.hash}`
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextHref !== currentHref) {
      window.history.pushState(window.history.state, '', nextHref)
    }

    if (isGenerate) {
      const rawQuery = url.search.replace(/^\?/, '')
      const store = useAgentConsoleStore.getState()
      store.consumeReuseQuery(rawQuery)
      const imageReuse = parseReuseImageQuery(rawQuery)
      if (imageReuse) {
        store.addDraftAttachment({
          id: imageReuse.assetId ? `lib-${imageReuse.assetId}` : `reuse-${imageReuse.url}`,
          url: imageReuse.url,
          name: imageReuse.label || '图库参考图',
          source: 'library',
          assetId: imageReuse.assetId ?? undefined,
          prompt: imageReuse.prompt ?? undefined,
        })
      }
      const panel = parseInspectorPanelQuery(rawQuery)
      if (panel) {
        store.setRightPanelTab(panel)
        store.setRightPanelOpen(true)
      }
      setRoute('generate')
    } else {
      setRoute('library')
    }
  }

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas"
      onClickCapture={handleClickCapture}
    >
      {route === 'library' ? (
        <LibraryView mode={mode} />
      ) : (
        <Suspense fallback={null}>
          <AgentConsoleView mode={mode} />
        </Suspense>
      )}
    </div>
  )
}
