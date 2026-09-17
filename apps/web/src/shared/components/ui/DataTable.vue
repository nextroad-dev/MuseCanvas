<script setup lang="ts" generic="T extends Record<string, unknown>">
import { computed, useSlots } from 'vue'
import { cn } from '@/shared/lib/utils'
import SkeletonBlock from './SkeletonBlock.vue'

export interface Column<T> {
  key: string
  label: string
  class?: string
  /** Right-aligned numeric columns also get `tabular-nums`. */
  align?: 'left' | 'right'
  /** Ids, timestamps and machine values render in the mono face. */
  mono?: boolean
  render?: (row: T) => string
}

const props = defineProps<{
  columns: Column<T>[]
  data: T[]
  rowKey: (row: T) => string
  emptyText?: string
  /** Distinguishes "nothing yet" from "no match for the current filters". */
  filtered?: boolean
  loading?: boolean
  loadingRows?: number
  stickyHeader?: boolean
}>()

const slots = useSlots()
const hasActions = !!slots.actions
const hasMobileCard = !!slots['mobile-card']

const loadingRowCount = computed(() => props.loadingRows || 4)
const emptyMessage = computed(
  () => props.emptyText || (props.filtered ? '没有符合筛选条件的结果' : '暂无数据'),
)

function headerClass(col: Column<T>) {
  return cn(
    'px-4 py-2.5 text-xs font-medium text-muted-foreground',
    col.align === 'right' ? 'text-right' : 'text-left',
    col.class,
  )
}

function cellClass(col: Column<T>) {
  return cn(
    'px-4 py-3 text-sm',
    col.align === 'right' ? 'text-right tabular-nums' : 'text-left',
    col.mono ? 'font-mono text-xs' : '',
    col.class,
  )
}
</script>

<template>
  <div class="overflow-x-auto" :aria-busy="loading || undefined">
    <!-- Desktop table -->
    <table class="hidden min-w-full text-sm md:table">
      <thead :class="cn('border-b border-border bg-surface-subtle', stickyHeader && 'sticky top-0 z-10')">
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            scope="col"
            :class="headerClass(col)"
          >
            {{ col.label }}
          </th>
          <th v-if="hasActions" scope="col" class="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
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
            class="px-4 py-12 text-center text-sm text-muted-foreground"
          >
            <slot name="empty">
              {{ emptyMessage }}
            </slot>
          </td>
        </tr>
        <!-- Data rows -->
        <template v-else>
          <tr
            v-for="row in data"
            :key="rowKey(row)"
            class="border-b border-border last:border-b-0 hover:bg-surface-subtle"
          >
            <td
              v-for="col in columns"
              :key="col.key"
              :class="cellClass(col)"
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
      <div v-else-if="data.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        <slot name="empty">
          {{ emptyMessage }}
        </slot>
      </div>
      <template v-else>
        <div v-for="row in data" :key="rowKey(row)" class="border-b border-border p-4 last:border-b-0">
          <slot v-if="hasMobileCard" name="mobile-card" :row="row" />
          <div v-else class="space-y-2">
            <div v-for="col in columns" :key="col.key" class="flex justify-between gap-2">
              <span class="text-xs text-muted-foreground">{{ col.label }}</span>
              <span :class="cn('text-sm', col.align === 'right' && 'tabular-nums', col.mono && 'font-mono text-xs')">
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