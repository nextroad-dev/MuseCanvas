<script setup lang="ts" generic="T extends Record<string, unknown>">
import { useSlots } from 'vue'
import { cn } from '@/shared/lib/utils'
import SkeletonBlock from './SkeletonBlock.vue'

export interface Column<T> {
  key: string
  label: string
  class?: string
  render?: (row: T) => string
}

const props = defineProps<{
  columns: Column<T>[]
  data: T[]
  rowKey: (row: T) => string
  emptyText?: string
  loading?: boolean
  loadingRows?: number
  stickyHeader?: boolean
}>()

const slots = useSlots()
const hasActions = !!slots.actions
const hasMobileCard = !!slots['mobile-card']

const loadingRowCount = props.loadingRows || 4
</script>

<template>
  <div class="overflow-x-auto">
    <!-- Desktop table -->
    <table class="hidden min-w-full text-sm md:table">
      <thead :class="cn('border-b border-border bg-surface-subtle', stickyHeader && 'sticky top-0 z-10')">
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            :class="cn('px-4 py-2.5 text-left text-xs font-medium text-muted-foreground', col.class)"
          >
            {{ col.label }}
          </th>
          <th v-if="hasActions" class="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
            操作
          </th>
        </tr>
      </thead>
      <tbody>
        <!-- Loading state -->
        <template v-if="loading">
          <tr v-for="i in loadingRowCount" :key="`skeleton-${i}`">
            <td :colspan="columns.length + (hasActions ? 1 : 0)" class="px-4 py-3">
              <SkeletonBlock variant="table-row" />
            </td>
          </tr>
        </template>
        <!-- Empty state -->
        <tr v-else-if="data.length === 0">
          <td
            :colspan="columns.length + (hasActions ? 1 : 0)"
            class="px-4 py-12 text-center text-xs text-muted-foreground"
          >
            <slot name="empty">
              {{ emptyText || '暂无数据' }}
            </slot>
          </td>
        </tr>
        <!-- Data rows -->
        <template v-else>
          <tr
            v-for="row in data"
            :key="rowKey(row)"
            class="border-b border-border transition-colors last:border-b-0 hover:bg-surface-subtle"
          >
            <td
              v-for="col in columns"
              :key="col.key"
              :class="cn('px-4 py-3 text-sm', col.class)"
            >
              <slot :name="`cell-${col.key}`" :row="row">
                {{ col.render ? col.render(row) : row[col.key] }}
              </slot>
            </td>
            <td v-if="hasActions" class="px-4 py-3 text-right">
              <slot name="actions" :row="row" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <!-- Mobile card view -->
    <div class="md:hidden">
      <div v-if="loading" class="space-y-3 p-4">
        <SkeletonBlock v-for="i in loadingRowCount" :key="i" variant="card" />
      </div>
      <div v-else-if="data.length === 0" class="px-4 py-12 text-center text-xs text-muted-foreground">
        <slot name="empty">
          {{ emptyText || '暂无数据' }}
        </slot>
      </div>
      <template v-else>
        <div v-for="row in data" :key="rowKey(row)" class="border-b border-border p-4 last:border-b-0">
          <slot v-if="hasMobileCard" name="mobile-card" :row="row" />
          <div v-else class="space-y-2">
            <div v-for="col in columns" :key="col.key" class="flex justify-between gap-2">
              <span class="text-xs text-muted-foreground">{{ col.label }}</span>
              <span class="text-sm">
                <slot :name="`cell-${col.key}`" :row="row">
                  {{ col.render ? col.render(row) : row[col.key] }}
                </slot>
              </span>
            </div>
            <div v-if="hasActions" class="pt-2">
              <slot name="actions" :row="row" />
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
