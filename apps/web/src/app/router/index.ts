import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { setupGuards } from './guards'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/features/auth/views/LoginPage.vue'),
    meta: { guest: true },
  },
  {
    path: '/',
    name: 'landing',
    component: () => import('@/features/auth/views/LandingPage.vue'),
    meta: { guest: true },
  },
  {
    path: '/terms',
    name: 'terms',
    component: () => import('@/features/legal/views/TermsPage.vue'),
    meta: { public: true },
  },
  {
    path: '/privacy',
    name: 'privacy',
    component: () => import('@/features/legal/views/PrivacyPage.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('@/app/layouts/UserLayout.vue'),
    children: [
      {
        path: 'generate',
        name: 'generate',
        component: () => import('@/features/generate/views/GeneratePage.vue'),
      },
      {
        path: 'history',
        redirect: { name: 'generate' },
      },
      {
        path: 'library',
        name: 'library',
        component: () => import('@/features/library/views/LibraryPage.vue'),
      },
      {
        path: 'account',
        name: 'account',
        component: () => import('@/features/account/views/AccountPage.vue'),
      },
    ],
  },
  {
    path: '/admin',
    component: () => import('@/app/layouts/AdminLayout.vue'),
    meta: { requiresAdmin: true },
    children: [
      {
        path: '',
        name: 'admin-dashboard',
        component: () => import('@/features/admin/views/AdminDashboard.vue'),
      },
      {
        path: 'registration',
        redirect: { name: 'admin-users' },
      },
      {
        path: 'oauth',
        name: 'admin-oauth',
        component: () => import('@/features/admin/views/AdminOAuthProviders.vue'),
      },
      {
        path: 'users',
        name: 'admin-users',
        component: () => import('@/features/admin/views/AdminUsers.vue'),
      },
      {
        path: 'models',
        name: 'admin-models',
        component: () => import('@/features/admin/views/AdminModels.vue'),
      },
      {
        path: 'providers',
        name: 'admin-providers',
        component: () => import('@/features/admin/views/AdminProviderCredentials.vue'),
      },
      {
        path: 'prompt-templates',
        name: 'admin-prompt-templates',
        component: () => import('@/features/admin/views/AdminPromptTemplates.vue'),
      },
      {
        path: 'jobs',
        name: 'admin-jobs',
        component: () => import('@/features/admin/views/AdminJobs.vue'),
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

setupGuards(router)

export default router
