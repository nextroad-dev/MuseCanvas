// 后端 REST 端点唯一真源，与 apps/api/app/api/[...path]/route.ts 逐字对齐。
// 所有值自带 /api 前缀；动态段使用函数 helper。新增端点必须同步此表。

export const OAUTH_PROVIDERS = ['github', 'google'] as const
export type OAuthProviderName = (typeof OAUTH_PROVIDERS)[number]

const P = '/api'

export const API_ENDPOINTS = {
  healthReady: `${P}/health/ready`,
  session: `${P}/session`,
  registration: `${P}/registration`,

  auth: {
    otpRequest: `${P}/auth/otp/request`,
    otpVerify: `${P}/auth/otp/verify`,
    logout: `${P}/auth/logout`,
    oauthProviders: `${P}/auth/oauth/providers`,
    oauthInvitation: `${P}/auth/oauth/invitation`,
    oauthStart: (provider: OAuthProviderName) => `${P}/auth/oauth/${provider}/start`,
    oauthCallback: (provider: OAuthProviderName) => `${P}/auth/oauth/${provider}/callback`,
  },

  account: {
    oauth: `${P}/account/oauth`,
    oauthLinkStart: (provider: OAuthProviderName) => `${P}/account/oauth/${provider}/link/start`,
    oauthUnlink: (provider: OAuthProviderName) => `${P}/account/oauth/${provider}`,
  },

  models: `${P}/models`,
  generations: `${P}/generations`,

  jobs: {
    list: `${P}/jobs`,
    detail: (id: string) => `${P}/jobs/${id}`,
    cancel: (id: string) => `${P}/jobs/${id}/cancel`,
    retry: (id: string) => `${P}/jobs/${id}/retry`,
  },

  library: {
    list: `${P}/library`,
    detail: (id: string) => `${P}/library/${id}`,
    download: (id: string) => `${P}/library/${id}/download`,
  },

  generationUploads: {
    create: `${P}/generation-uploads`,
    complete: (id: string) => `${P}/generation-uploads/${id}/complete`,
    remove: (id: string) => `${P}/generation-uploads/${id}`,
  },

  setup: {
    status: `${P}/setup/status`,
    config: `${P}/setup/config`,
    complete: `${P}/setup/complete`,
    claim: `${P}/setup/claim`,
    site: `${P}/setup/site`,
    smtp: `${P}/setup/smtp`,
    smtpTest: `${P}/setup/smtp/test`,
    storage: `${P}/setup/storage`,
    storageTest: `${P}/setup/storage/test`,
    runtime: `${P}/setup/runtime`,
    promptTemplatesImport: `${P}/setup/prompt-templates/import`,
    adminRequest: `${P}/setup/admin/request`,
    adminVerify: `${P}/setup/admin/verify`,
  },

  admin: {
    dashboard: `${P}/admin/dashboard`,
    registration: `${P}/admin/registration`,
    jobs: `${P}/admin/jobs`,
    users: `${P}/admin/users`,
    // 后端以同一正则 `(?:/status)?` 处理 PATCH admin/users/{id}[/status]
    user: (id: string) => `${P}/admin/users/${id}`,
    userStatus: (id: string) => `${P}/admin/users/${id}/status`,
    invitations: `${P}/admin/invitations`,
    invitation: (id: string) => `${P}/admin/invitations/${id}`,
    models: `${P}/admin/models`,
    model: (id: string) => `${P}/admin/models/${id}`,
    modelPresets: `${P}/admin/model-presets`,
    providerCredentials: `${P}/admin/provider-credentials`,
    providerCredential: (id: string) => `${P}/admin/provider-credentials/${id}`,
    providerCredentialTest: (id: string) => `${P}/admin/provider-credentials/${id}/test`,
    providerTemplates: `${P}/admin/provider-templates`,
    oauthProviders: `${P}/admin/oauth-providers`,
    oauthProvider: (provider: OAuthProviderName) => `${P}/admin/oauth-providers/${provider}`,
    // GET 返回当前激活集详情（PromptTemplateSetDetailDto | null）
    promptTemplates: `${P}/admin/prompt-templates`,
    promptTemplateSets: `${P}/admin/prompt-templates/sets`,
    promptTemplateSet: (id: string) => `${P}/admin/prompt-templates/sets/${id}`,
    promptTemplateSetActivate: (id: string) => `${P}/admin/prompt-templates/sets/${id}/activate`,
    promptTemplateSetEntries: (id: string) => `${P}/admin/prompt-templates/sets/${id}/entries`,
    promptTemplateEntry: (id: string) => `${P}/admin/prompt-templates/entries/${id}`,
    promptTemplatesImport: `${P}/admin/prompt-templates/import`,
    promptTemplatesPreview: `${P}/admin/prompt-templates/preview`,
    promptTemplatesExport: `${P}/admin/prompt-templates/export`,
    promptOptimizationSettings: `${P}/admin/prompt-optimization-settings`,
  },
} as const
