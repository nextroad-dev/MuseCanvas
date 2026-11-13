// 全部 TanStack Query key 的唯一来源：页面/hook 不再各自拼字面量数组。
// 失效（invalidate）按域根 key 精确刷新；跨域级联在 mutation 里显式声明。

export const JOB_POLL_MS = 2500
/** Agent turn 恢复轮询间隔（仅断线恢复时使用，正常走 SSE）。 */
export const CANVAS_AGENT_POLL_MS = 2000

export const queryKeys = {
  session: ['session'] as const,
  account: ['account'] as const,
  models: ['models'] as const,

  jobs: {
    root: ['jobs'] as const,
    list: (filters?: unknown) => ['jobs', 'list', filters ?? null] as const,
    detail: (id: string) => ['jobs', 'detail', id] as const,
  },

  library: {
    root: ['library'] as const,
    list: (filters?: unknown) => ['library', 'list', filters ?? null] as const,
    detail: (id: string) => ['library', 'detail', id] as const,
  },

  canvases: {
    root: ['canvases'] as const,
    list: () => ['canvases', 'list'] as const,
    detail: (id: string) => ['canvases', 'detail', id] as const,
  },

  canvasAgent: {
    root: ['canvas-agent'] as const,
    status: ['canvas-agent', 'status'] as const,
    history: (canvasId: string) => ['canvas-agent', 'history', canvasId] as const,
    turn: (canvasId: string, turnId: string) => ['canvas-agent', 'turn', canvasId, turnId] as const,
  },

  setup: {
    root: ['setup'] as const,
    status: ['setup', 'status'] as const,
    config: ['setup', 'config'] as const,
    database: ['setup', 'database'] as const,
  },

  admin: {
    root: ['admin'] as const,
    dashboard: ['admin', 'dashboard'] as const,
    users: (filters?: unknown) => ['admin', 'users', filters ?? null] as const,
    jobs: (filters?: unknown) => ['admin', 'jobs', filters ?? null] as const,
    invitations: ['admin', 'invitations'] as const,
    models: ['admin', 'models'] as const,
    modelPresets: ['admin', 'model-presets'] as const,
    providerCredentials: ['admin', 'provider-credentials'] as const,
    providerTemplates: ['admin', 'provider-templates'] as const,
    plugins: ['admin', 'plugins'] as const,
    oauthProviders: ['admin', 'oauth-providers'] as const,
    promptTemplates: ['admin', 'prompt-templates'] as const,
    promptTemplateSets: ['admin', 'prompt-template-sets'] as const,
    promptOptimizationSettings: ['admin', 'prompt-optimization-settings'] as const,
    canvasAgentSettings: ['admin', 'canvas-agent-settings'] as const,
    mediaModelDefaults: ['admin', 'media-model-defaults'] as const,
    registration: ['admin', 'registration'] as const,
  },
} as const
