<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

onMounted(() => {
  router.replace('/admin/users')
})
</script>

<template>
  <div class="text-sm text-muted-foreground">注册设置已合并到用户管理，正在跳转...</div>
</template>
