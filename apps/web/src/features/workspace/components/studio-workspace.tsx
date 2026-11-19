'use client'

import { Suspense } from 'react'
import { AgentConsoleView } from '@/features/agent-console/components/agent-console-view'
import { LibraryView } from '@/features/library/components/library-view'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'

export interface StudioWorkspaceProps {
  mode: WorkspaceMode
  initialRoute: 'generate' | 'library'
  /** Runtime-provisioned default Agent, resolved from server env per request. */
  defaultAgentDefinition?: { agentDefinitionId: string; definitionVersion: number } | null
  /** Deep-link target: the console selects this session once on mount. */
  initialSessionId?: string | null
}

/**
 * 工作台路由视图容器：在统一 `AppShell` 下直接挂载对应路由的工作区内容。
 */
export function StudioWorkspace({ mode, initialRoute, defaultAgentDefinition = null, initialSessionId = null }: StudioWorkspaceProps) {
  if (initialRoute === 'library') {
    return <LibraryView mode={mode} />
  }

  return (
    <Suspense fallback={null}>
      <AgentConsoleView
        mode={mode}
        defaultAgentDefinition={defaultAgentDefinition}
        initialSessionId={initialSessionId}
      />
    </Suspense>
  )
}
