// 全部 TanStack Query key 的唯一来源：页面/hook 不再各自拼字面量数组。
// 失效（invalidate）按域根 key 精确刷新；跨域级联在 mutation 里显式声明。

export const JOB_POLL_MS = 2500

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

  agent: {
    root: ['agent'] as const,
    artifacts: (actorId: string, sessionId: string) => ['agent', 'artifacts', actorId, sessionId] as const,
    artifact: (actorId: string, sessionId: string, artifactId: string) => ['agent', 'artifact', actorId, sessionId, artifactId] as const,
    artifactThreads: (actorId: string, sessionId: string, artifactId: string) => ['agent', 'artifact-threads', actorId, sessionId, artifactId] as const,
    artifactAsset: (actorId: string, sessionId: string, assetId: string) => ['agent', 'artifact-asset', actorId, sessionId, assetId] as const,
    sessions: (actorId = '') => ['agent', 'sessions', actorId] as const,
    snapshot: (actorId: string, sessionId: string) => ['agent', 'snapshot', actorId, sessionId] as const,
    items: (actorId: string, sessionId: string) => ['agent', 'items', actorId, sessionId] as const,
    turn: (actorId: string, turnId: string) => ['agent', 'turn', actorId, turnId] as const,
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
    pluginDocs: (id: string) => ['admin', 'plugin-docs', id] as const,
    oauthProviders: ['admin', 'oauth-providers'] as const,
    promptTemplates: ['admin', 'prompt-templates'] as const,
    promptTemplateSets: ['admin', 'prompt-template-sets'] as const,
    promptTemplateSet: (id: string) => ['admin', 'prompt-template-set', id] as const,
    promptOptimizationSettings: ['admin', 'prompt-optimization-settings'] as const,
    mediaModelDefaults: ['admin', 'media-model-defaults'] as const,
    registration: ['admin', 'registration'] as const,
  },
} as const
