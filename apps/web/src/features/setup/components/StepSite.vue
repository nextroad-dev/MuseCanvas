<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSetupStore } from '../stores/setup'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'

const setup = useSetupStore()

const siteName = ref('')
const siteUrl = ref('')
const formError = ref('')
let hydrated = false

function hydrate() {
  const site = setup.config?.site
  if (!site) return
  if (!hydrated) {
    siteName.value = site.siteName || ''
    siteUrl.value = site.siteUrl || ''
    hydrated = true
  }
}

watch(() => setup.config?.site, hydrate, { immediate: true })

const saved = computed(() => setup.config?.site ?? null)
const done = computed(() => setup.isSectionComplete('site'))

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

async function handleSave() {
  formError.value = ''
  const name = siteName.value.trim()
  const url = siteUrl.value.trim()
  if (url && !validOrigin(url)) {
    formError.value = '站点地址必须是合法的 http(s) 地址，例如 https://example.com'
    return
  }
  const res = await setup.saveSite({
    siteName: name ? name : null,
    siteUrl: url ? url : null,
  })
  if (!res.success) return
  await setup.fetchConfig().catch(() => {})
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">站点设置</h3>
      <p class="text-sm text-muted-foreground">站点名称与公开访问地址，用于拼接回调与外链。保存后自动标记本节完成。</p>
    </div>

    <AppAlert v-if="done" type="success" message="站点设置已完成，之后可在管理后台修改。" />
    <AppAlert v-if="saved && !done" type="info" message="已保存草稿，服务端尚未标记完成；请检查输入后重新保存。" />

    <div class="grid gap-4 sm:grid-cols-2">
      <Field label="站点名称" hint="展示给用户的产品名称">
        <TextInput v-model="siteName" type="text" placeholder="MuseCanvas" autocomplete="off" />
      </Field>
      <Field label="站点公开地址" hint="例如 https://example.com，用于 OAuth 回调与外链" :error="formError || undefined">
        <TextInput
          v-model="siteUrl"
          type="url"
          placeholder="https://example.com"
          autocomplete="url"
          :invalid="!!formError"
        />
      </Field>
    </div>

    <AppAlert v-if="setup.sectionError('site')" type="error" title="保存失败" :message="setup.sectionError('site')" />

    <div v-if="saved" class="rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
      已保存版本 rev {{ saved.revision }} · 更新于 {{ new Date(saved.updatedAt).toLocaleString('zh-CN') }}
    </div>

    <BaseButton class="w-full sm:w-auto" :loading="setup.isBusy('site')" @click="handleSave">
      {{ setup.isBusy('site') ? '保存中...' : '保存站点设置' }}
    </BaseButton>
  </div>
</template>
