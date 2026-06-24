<script setup lang="ts" generic="T extends string">
import { computed, useSlots } from 'vue'
import type { VNode } from 'vue'
import BaseDropdown from './BaseDropdown.vue'

defineOptions({ inheritAttrs: false })

defineProps<{ modelValue: T; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const slots = useSlots()

interface ExtractedOption {
  value: string
  label: string
}

function getText(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  return ''
}

function isFragment(node: VNode): boolean {
  return typeof node.type === 'symbol'
}

function extractOptions(vnodes: unknown[]): ExtractedOption[] {
  const result: ExtractedOption[] = []

  for (const vnode of vnodes) {
    if (!vnode || typeof vnode !== 'object') continue

    const node = vnode as VNode

    if (isFragment(node)) {
      if (Array.isArray(node.children)) {
        result.push(...extractOptions(node.children))
      }
      continue
    }

    if (node.type === 'option') {
      const value = String((node.props as Record<string, unknown>)?.value ?? '')
      let label = ''
      if (typeof node.children === 'string') {
        label = node.children
      } else if (Array.isArray(node.children)) {
        label = node.children.map(getText).join('')
      }
      result.push({ value, label })
      continue
    }

    if (Array.isArray(node.children)) {
      result.push(...extractOptions(node.children))
    }
  }

  return result
}

const options = computed<ExtractedOption[]>(() => {
  const slotContent = slots.default?.()
  if (!slotContent) return []

  const nodes = Array.isArray(slotContent) ? slotContent : [slotContent]
  return extractOptions(nodes)
})
</script>

<template>
  <BaseDropdown
    :model-value="modelValue"
    :options="options"
    :disabled="disabled"
    @update:model-value="(val) => emit('update:modelValue', val as T)"
  />
</template>
