import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { setupGuards } from './guards'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/auth/LoginPage.vue'),
    meta: { guest: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/UserLayout.vue'),
    children: [
      {
        path: '',
        redirect: '/generate',
      },
      {
        path: 'generate',
        name: 'generate',
        component: () => import('@/views/user/GeneratePage.vue'),
      },
      {
        path: 'library',
        name: 'library',
        component: () => import('@/views/user/LibraryPage.vue'),
      },
      {
        path: 'account',
        name: 'account',
        component: () => import('@/views/user/AccountPage.vue'),
      },
    ],
  },
  {
    path: '/admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    meta: { requiresAdmin: true },
    children: [
      {
        path: '',
        name: 'admin-dashboard',
        component: () => import('@/views/admin/AdminDashboard.vue'),
      },
      {
        path: 'registration',
        name: 'admin-registration',
        component: () => import('@/views/admin/AdminRegistration.vue'),
      },
      {
        path: 'smtp',
        name: 'admin-smtp',
        component: () => import('@/views/admin/AdminSmtp.vue'),
      },
      {
        path: 'oauth',
        name: 'admin-oauth',
        component: () => import('@/views/admin/AdminOAuthProviders.vue'),
      },
      {
        path: 'users',
        name: 'admin-users',
        component: () => import('@/views/admin/AdminUsers.vue'),
      },
      {
        path: 'models',
        name: 'admin-models',
        component: () => import('@/views/admin/AdminModels.vue'),
      },
      {
        path: 'providers',
        name: 'admin-providers',
        component: () => import('@/views/admin/AdminProviderCredentials.vue'),
      },
      {
        path: 'jobs',
        name: 'admin-jobs',
        component: () => import('@/views/admin/AdminJobs.vue'),
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
