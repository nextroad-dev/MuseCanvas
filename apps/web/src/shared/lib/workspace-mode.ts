/** Build-time opt-in shared by RSC guards and client APIs; never a production bypass. */
export type WorkspaceMode = 'live' | 'mock'

export const WORKSPACE_MODE: WorkspaceMode =
  process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_WORKSPACE_MOCK === 'true'
    ? 'mock'
    : 'live'
