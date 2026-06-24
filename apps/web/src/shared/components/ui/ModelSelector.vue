<script setup lang="ts">
import { computed } from 'vue'
import type { ModelConfig } from '@/shared/types'
import BaseDropdown from '@/shared/components/ui/BaseDropdown.vue'

const props = defineProps<{
  models: ModelConfig[]
  disabled?: boolean
}>()

const model = defineModel<string>({ required: true })

const options = computed(() =>
  props.models.map(m => ({ value: m.id, label: m.displayName })),
)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label class="text-sm font-medium text-neutral-700">模型</label>
    <BaseDropdown v-model="model" :options="options" :disabled="disabled" />
  </div>
</template>
