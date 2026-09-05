<script setup lang="ts">
import { ref } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import {
  LayoutDashboard, ShieldCheck, Users, Cpu, ListTodo, Key, FileText,
  ArrowLeft, Menu, Coins, Settings,
} from 'lucide-vue-next'
import AppDrawer from '@/shared/components/ui/AppDrawer.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import NavLink from '@/shared/components/ui/NavLink.vue'

const auth = useAuthStore()
const route = useRoute()
const drawerOpen = ref(false)

interface NavGroup {
  title?: string
  items: { name: string; path: string; label: string; icon: typeof LayoutDashboard }[]
}

const navGroups: NavGroup[] = [
  { items: [{ name: 'admin-dashboard', path: '/admin', label: '概览', icon: LayoutDashboard }] },
  {
    title: '用户与权限',
    items: [{ name: 'admin-users', path: '/admin/users', label: '用户管理', icon: Users }],
  },
  {
    title: '生成资源',
    items: [
      { name: 'admin-models', path: '/admin/models', label: '模型管理', icon: Cpu },
      { name: 'admin-providers', path: '/admin/providers', label: '供应商凭据', icon: Key },
      { name: 'admin-prompt-templates', path: '/admin/prompt-templates', label: '提示词模板', icon: FileText },
    ],
  },
  {
    title: '系统设置',
    items: [
      { name: 'admin-billing', path: '/admin/billing', label: '计费设置', icon: Coins },
      { name: 'admin-oauth', path: '/admin/oauth', label: 'OAuth', icon: ShieldCheck },
      { name: 'setup', path: '/setup?step=site', label: '系统配置', icon: Settings },
    ],
  },
  { items: [{ name: 'admin-jobs', path: '/admin/jobs', label: '任务监控', icon: ListTodo }] },
]
</script>

<template>
  <div class="flex h-screen flex-col bg-canvas text-foreground">
    <!-- Top bar -->
    <header class="flex h-16 shrink-0 items-center border-b border-border bg-surface px-4 sm:px-6">
      <BaseButton to="/generate" size="sm">
        <template #icon>
          <ArrowLeft class="h-4 w-4" />
        </template>
        返回创作端
      </BaseButton>

      <span class="ml-4 hidden text-sm font-semibold text-foreground md:inline">管理后台</span>

      <!-- Mobile menu -->
      <button
        class="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-surface-subtle md:hidden"
        aria-label="打开菜单"
        @click="drawerOpen = true"
      >
        <Menu class="h-5 w-5" />
      </button>

      <div class="ml-auto hidden items-center gap-3 md:flex">
        <span class="text-xs text-muted-foreground">{{ auth.user?.email }}</span>
        <button
          class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-primary transition-all hover:ring-2 hover:ring-primary/30 hover:bg-primary/20 active:scale-95"
          :title="auth.user?.email"
        >
          <span class="text-sm font-medium">{{ auth.user?.email?.charAt(0).toUpperCase() }}</span>
        </button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <!-- Sidebar -->
      <aside class="hidden w-60 shrink-0 border-r border-border bg-surface py-3 md:flex">
        <nav class="flex w-full flex-col gap-4 px-2">
          <div v-for="group in navGroups" :key="group.title || group.items[0]?.name" class="flex flex-col gap-0.5">
            <div
              v-if="group.title"
              class="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              {{ group.title }}
            </div>
            <NavLink
              v-for="item in group.items"
              :key="item.name"
              :to="item.path"
              :active="route.name === item.name"
              class="flex items-center gap-2"
            >
              <component :is="item.icon" class="h-4 w-4 shrink-0" />
              <span class="truncate">{{ item.label }}</span>
            </NavLink>
          </div>
        </nav>
      </aside>

      <!-- Content -->
      <main class="flex-1 overflow-auto p-4 sm:p-6">
        <RouterView />
      </main>
    </div>
  </div>

  <!-- Mobile drawer -->
  <AppDrawer
    :open="drawerOpen"
    title="管理后台"
    position="left"
    @update:open="drawerOpen = $event"
  >
    <nav class="flex flex-col gap-1">
      <div v-for="group in navGroups" :key="group.title || group.items[0]?.name" class="flex flex-col gap-0.5">
        <div v-if="group.title" class="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {{ group.title }}
        </div>
        <NavLink
          v-for="item in group.items"
          :key="item.name"
          :to="item.path"
          :active="route.name === item.name"
          class="flex items-center gap-2"
          @click="drawerOpen = false"
        >
          <component :is="item.icon" class="h-4 w-4 shrink-0" />
          {{ item.label }}
        </NavLink>
      </div>
    </nav>
  </AppDrawer>
</template>
