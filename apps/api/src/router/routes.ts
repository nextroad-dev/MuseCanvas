import { fail, ok } from '../shared/http'
import type { OAuthProvider } from '../auth/oauth'
import { adminOAuthSettings, oauthProviderList } from '../modules/auth/oauth-settings'
import { completeOAuthInvitation, handleOAuthCallback, startOAuth } from '../modules/auth/oauth-flow'
import { handleSetupPost, setupConfig, setupStatus } from '../modules/setup/handlers'
import { readiness } from '../modules/health/handlers'
import { readSession, registrationMode, setRegistrationMode } from '../modules/session/handlers'
import { listLinkedIdentities, startLink, unlinkIdentity } from '../modules/auth/account'
import { logout, requestOtp, verifyOtp } from '../modules/auth/handlers'
import { listAdminModels, listPublicModels } from '../modules/models/queries'
import { deleteModel, upsertModel } from '../modules/models/handlers'
import { cancelJob, deleteJob, getJob, listJobs, retryJob } from '../modules/jobs/handlers'
import { deleteAsset, downloadAsset, listLibrary } from '../modules/library/handlers'
import { createGeneration } from '../modules/generations/create'
import { editImage } from '../modules/image-edit/handlers'
import {
  completeGenerationUpload,
  createGenerationUpload,
  deleteGenerationUpload,
} from '../modules/generation-uploads'
import { dashboard } from '../modules/admin/dashboard'
import { deleteUser, listUsers, setUserStatus } from '../modules/admin/users'
import { listJobs as listAdminJobs } from '../modules/admin/jobs'
import { createInvitation, listInvitations, revokeInvitation } from '../modules/admin/invitations'
import { readPromptOptimizationSettings, updatePromptOptimizationSettings } from '../modules/admin/prompt-optimization'
import { listInstalledCatalogPlugins, listModelPresets } from '../modules/admin/plugin-catalog'
import { buildBuiltinProviderTemplates } from '../admin/provider-templates'
import {
  deletePlugin,
  installPlugin,
  listAdminPlugins,
  updatePluginStatus,
  validatePluginPackage,
} from '../modules/admin/plugins'
import { listProviderCredentials } from '../modules/admin/credential-reads'
import {
  createProviderCredential,
  deleteProviderCredential,
  testProviderCredential,
  updateProviderCredential,
} from '../modules/admin/provider-credentials'
import { updateOAuthProvider } from '../modules/admin/oauth'
import {
  activatePromptTemplateSet,
  createPromptTemplateEntry,
  deletePromptTemplateEntry,
  deletePromptTemplateSet,
  exportPromptTemplates,
  getAdminPromptTemplates,
  getPromptTemplateSetDetail,
  importPromptTemplates,
  listPromptTemplateSets,
  previewPromptTemplate,
  updatePromptTemplateEntry,
} from '../modules/admin/prompt-templates'
import type { Route } from './types'

/**
 * The API surface, as data.
 *
 * Order is precedence, preserved from the old inline handler. Paths mirror
 * `API_ENDPOINTS` in `@musecanvas/contracts` — the single source of truth for
 * URLs — and `router.test.ts` fails if the two diverge in either direction.
 *
 * Handlers take the whole context. Anything needing the JSON body awaits
 * `context.json()`, which is lazy, so the multipart upload routes below can
 * answer without ever consuming the request stream.
 */

/** The setup wizard posts to these eleven paths; all public, all pre-body. */
const SETUP_POST_PATHS = [
  'setup/complete',
  'setup/claim',
  'setup/site',
  'setup/smtp',
  'setup/smtp/test',
  'setup/storage',
  'setup/storage/test',
  'setup/runtime',
  'setup/prompt-templates/import',
  'setup/admin/request',
  'setup/admin/verify',
] as const

const setupRoute = (path: (typeof SETUP_POST_PATHS)[number]): Route => ({
  path,
  access: 'public',
  // `handleSetupPost` returns null for a path it does not own, which the old
  // handler turned into a 404; that distinction is preserved.
  handler: context => handleSetupPost(context.request, path).then(response => response ?? fail('NOT_FOUND', '接口不存在', 404)),
})

export const GET_ROUTES: Route[] = [
  // --- public -------------------------------------------------------------
  { path: 'health/ready', access: 'public', handler: () => readiness() },
  { path: 'setup/status', access: 'public', handler: () => setupStatus() },
  { path: 'setup/config', access: 'public', handler: context => setupConfig(context.request) },
  { path: 'registration', access: 'public', handler: context => registrationMode(context) },
  { path: 'auth/oauth/providers', access: 'public', handler: async () => ok({ providers: await oauthProviderList() }) },
  { path: 'auth/oauth/:oauth/start', access: 'public', handler: context => startOAuth(context.params.oauth as OAuthProvider, 'login') },
  { path: 'auth/oauth/:oauth/callback', access: 'public', handler: context => handleOAuthCallback(context.request, context.params.oauth as OAuthProvider) },

  // --- the caller's own account -------------------------------------------
  { path: 'session', access: 'actor', handler: context => readSession(context) },
  { path: 'account/oauth', access: 'actor', handler: context => listLinkedIdentities(context) },
  { path: 'account/oauth/:oauth/link/start', access: 'actor', handler: context => startLink(context) },
  // The model catalog is behind the session gate: it was in the old handler too,
  // after the global gate and before any admin route.
  { path: 'models', access: 'actor', handler: () => listPublicModels() },
  { path: 'jobs', access: 'actor', handler: context => listJobs(context) },
  { path: 'jobs/:id', access: 'actor', handler: context => getJob(context) },
  { path: 'library', access: 'actor', handler: context => listLibrary(context) },
  { path: 'library/:id/download', access: 'actor', handler: context => downloadAsset(context) },

  // --- administration -----------------------------------------------------
  { path: 'admin/dashboard', access: 'admin', handler: () => dashboard() },
  { path: 'admin/registration', access: 'admin', handler: context => registrationMode(context) },
  { path: 'admin/users', access: 'admin', handler: context => listUsers(context) },
  { path: 'admin/model-presets', access: 'admin', handler: async () => ok(await listModelPresets()) },
  { path: 'admin/provider-templates', access: 'admin', handler: async () => ok({ templates: buildBuiltinProviderTemplates(await listInstalledCatalogPlugins()) }) },
  { path: 'admin/plugins', access: 'admin', handler: () => listAdminPlugins() },
  { path: 'admin/models', access: 'admin', handler: () => listAdminModels() },
  { path: 'admin/prompt-templates', access: 'admin', handler: () => getAdminPromptTemplates() },
  { path: 'admin/prompt-templates/sets', access: 'admin', handler: () => listPromptTemplateSets() },
  { path: 'admin/prompt-templates/export', access: 'admin', handler: context => exportPromptTemplates(context.request.nextUrl.searchParams.get('setId') || undefined) },
  { path: 'admin/prompt-templates/sets/:hexid', access: 'admin', handler: context => getPromptTemplateSetDetail(context.params.hexid) },
  { path: 'admin/prompt-optimization-settings', access: 'admin', handler: () => readPromptOptimizationSettings() },
  { path: 'admin/jobs', access: 'admin', handler: context => listAdminJobs(context) },
  { path: 'admin/invitations', access: 'admin', handler: () => listInvitations() },
  { path: 'admin/oauth-providers', access: 'admin', handler: async () => ok(await adminOAuthSettings()) },
  { path: 'admin/provider-credentials', access: 'admin', handler: () => listProviderCredentials() },
]

export const POST_ROUTES: Route[] = [
  // The wizard never reaches the session gate.
  ...SETUP_POST_PATHS.map(setupRoute),
  // Plugin uploads are multipart, so they are dispatched before anything that
  // reads the JSON body, and neither handler calls context.json().
  { path: 'admin/plugins/upload', access: 'admin', handler: context => installPlugin(context.actor, context.request) },
  { path: 'admin/plugins/validate', access: 'admin', handler: context => validatePluginPackage(context.request) },

  // The login flow, still anonymous.
  { path: 'auth/otp/request', access: 'public', handler: context => requestOtp(context) },
  { path: 'auth/otp/verify', access: 'public', handler: context => verifyOtp(context) },
  { path: 'auth/logout', access: 'public', handler: context => logout(context) },
  { path: 'auth/oauth/invitation', access: 'public', handler: async context => completeOAuthInvitation(context.request, await context.json()) },

  // --- authenticated ------------------------------------------------------
  { path: 'generation-uploads', access: 'actor', handler: async context => createGenerationUpload(context.actor, await context.json()) },
  { path: 'generation-uploads/:id/complete', access: 'actor', handler: context => completeGenerationUpload(context.actor, context.params.id) },
  { path: 'generations', access: 'actor', handler: context => createGeneration(context) },
  // Multipart like the plugin uploads above, and it never calls `context.json()`:
  // the source image and the mask arrive as file parts.
  { path: 'images/edit', access: 'actor', handler: context => editImage(context) },
  { path: 'jobs/:id/cancel', access: 'actor', handler: context => cancelJob(context) },
  { path: 'jobs/:id/retry', access: 'actor', handler: context => retryJob(context) },

  // --- administration -----------------------------------------------------
  { path: 'admin/invitations', access: 'admin', handler: context => createInvitation(context) },
  { path: 'admin/models', access: 'admin', handler: async context => upsertModel(context.actor, await context.json()) },
  { path: 'admin/prompt-templates/import', access: 'admin', handler: async context => importPromptTemplates(context.actor, await context.json()) },
  { path: 'admin/prompt-templates/preview', access: 'admin', handler: async context => previewPromptTemplate(await context.json()) },
  { path: 'admin/prompt-templates/sets/:hexid/activate', access: 'admin', handler: context => activatePromptTemplateSet(context.actor, context.params.hexid) },
  { path: 'admin/prompt-templates/sets/:hexid/entries', access: 'admin', handler: async context => createPromptTemplateEntry(context.actor, context.params.hexid, await context.json()) },
  { path: 'admin/provider-credentials', access: 'admin', handler: async context => createProviderCredential(context.actor, await context.json()) },
  { path: 'admin/provider-credentials/:id/test', access: 'admin', handler: context => testProviderCredential(context.actor, context.params.id) },
]

export const PATCH_ROUTES: Route[] = [
  { path: 'admin/registration', access: 'admin', handler: context => setRegistrationMode(context) },
  { path: 'admin/prompt-optimization-settings', access: 'admin', handler: async context => updatePromptOptimizationSettings(context.actor, await context.json()) },
  // The old single regex accepted both the bare id and the `/status` alias. Two
  // entries say the same thing, and `:id` cannot span a slash, so they never
  // overlap.
  { path: 'admin/users/:id/status', access: 'admin', handler: context => setUserStatus(context) },
  { path: 'admin/users/:id', access: 'admin', handler: context => setUserStatus(context) },
  { path: 'admin/models/:id', access: 'admin', handler: async context => upsertModel(context.actor, await context.json(), context.params.id) },
  { path: 'admin/plugins/:hexid', access: 'admin', handler: async context => updatePluginStatus(context.actor, context.params.hexid, await context.json()) },
  { path: 'admin/provider-credentials/:id', access: 'admin', handler: async context => updateProviderCredential(context.actor, context.params.id, await context.json()) },
  { path: 'admin/oauth-providers/:oauth', access: 'admin', handler: async context => updateOAuthProvider(context.actor, context.params.oauth as OAuthProvider, await context.json()) },
  { path: 'admin/prompt-templates/entries/:hexid', access: 'admin', handler: async context => updatePromptTemplateEntry(context.actor, context.params.hexid, await context.json()) },
]

export const DELETE_ROUTES: Route[] = [
  { path: 'generation-uploads/:id', access: 'actor', handler: context => deleteGenerationUpload(context.actor, context.params.id) },
  { path: 'jobs/:id', access: 'actor', handler: context => deleteJob(context) },
  { path: 'library/:id', access: 'actor', handler: context => deleteAsset(context) },
  { path: 'admin/invitations/:id', access: 'admin', handler: context => revokeInvitation(context) },
  { path: 'admin/users/:id', access: 'admin', handler: context => deleteUser(context) },
  { path: 'admin/provider-credentials/:id', access: 'admin', handler: context => deleteProviderCredential(context.actor, context.params.id) },
  { path: 'admin/plugins/:hexid', access: 'admin', handler: context => deletePlugin(context.actor, context.params.hexid) },
  { path: 'admin/models/:id', access: 'admin', handler: context => deleteModel(context.actor, context.params.id) },
  { path: 'admin/prompt-templates/sets/:hexid', access: 'admin', handler: context => deletePromptTemplateSet(context.actor, context.params.hexid) },
  { path: 'admin/prompt-templates/entries/:hexid', access: 'admin', handler: context => deletePromptTemplateEntry(context.actor, context.params.hexid) },
  { path: 'account/oauth/:oauth', access: 'actor', handler: context => unlinkIdentity(context) },
]
