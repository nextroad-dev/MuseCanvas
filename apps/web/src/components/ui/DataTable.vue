<script setup lang="ts" generic="T extends Record<string, unknown>">
import { useSlots } from 'vue'
import { cn } from '@/lib/utils'

export interface Column<T> {
  key: string
  label: string
  class?: string
  render?: (row: T) => string
}

defineProps<{
  columns: Column<T>[]
  data: T[]
  rowKey: (row: T) => string
  emptyText?: string
}>()

const slots = useSlots()
const hasActions = !!slots.actions
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-neutral-200">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-neutral-200 bg-neutral-50">
          <th
            v-for="col in columns"
            :key="col.key"
            :class="cn('px-4 py-2.5 text-left text-xs font-medium text-neutral-500', col.class)"
          >
            {{ col.label }}
          </th>
          <th v-if="hasActions" class="px-4 py-2.5 text-right text-xs font-medium text-neutral-500">
            操作
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="data.length === 0">
          <td
            :colspan="columns.length + (hasActions ? 1 : 0)"
            class="px-4 py-12 text-center text-xs text-neutral-500"
          >
            {{ emptyText || '暂无数据' }}
          </td>
        </tr>
        <tr
          v-for="row in data"
          :key="rowKey(row)"
          class="border-b border-neutral-100 transition-colors hover:bg-neutral-50"
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
      </tbody>
    </table>
  </div>
</template>
