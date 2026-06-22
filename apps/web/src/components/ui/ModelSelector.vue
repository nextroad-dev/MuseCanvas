<script setup lang="ts">
import type { ModelConfig } from '@/types'
import BaseSelect from '@/components/ui/BaseSelect.vue'

defineProps<{
  models: ModelConfig[]
  disabled?: boolean
}>()

const model = defineModel<string>({ required: true })
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label class="text-xs font-medium text-neutral-700">模型</label>
    <BaseSelect
      v-model="model"
      :disabled="disabled"
    >
      <option v-for="m in models" :key="m.id" :value="m.id">
        {{ m.displayName }}
      </option>
    </BaseSelect>
  </div>
</template>
