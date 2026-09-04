<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import { toast } from '@/shared/composables/useToast'
import { parseTemplateImportFile } from '@/features/setup/lib/templateImport'
import {
  buildImportPromptTemplateSetInput,
  extractTemplateVariables,
  type StagedPromptTemplateEntry,
} from '@/features/admin/lib/prompt-templates'
import { ALLOWED_PROMPT_TEMPLATE_VARS } from '@/shared/types'
import type {
  Column,
} from '@/shared/components/ui/DataTable.vue'
import type {
  PromptTemplateEntryDto,
  PromptTemplateSetDetailDto,
  PromptTemplateSetSummaryDto,
  RenderPromptTemplateResult,
} from '@/shared/types'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import DataTable from '@/shared/components/ui/DataTable.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import AppModal from '@/shared/components/ui/AppModal.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import Field from '@/shared/components/ui/Field.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Textarea from '@/shared/components/ui/Textarea.vue'
import Badge from '@/shared/components/ui/Badge.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'
import EmptyState from '@/shared/components/ui/EmptyState.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'

type PromptTemplateEntryRow = PromptTemplateEntryDto & Record<string, unknown>
type PromptTemplateSetRow = PromptTemplateSetSummaryDto & Record<string, unknown>

const admin = useAdminStore()

const loading = ref(true)
const loadError = ref('')
const detailLoading = ref(false)
const detailError = ref('')

/** Null = active set; otherwise the id of the history version being viewed. */
const viewingSetId = ref<string | null>(null)

const viewingSet = computed<PromptTemplateSetDetailDto | null>(() => {
  if (!viewingSetId.value) return admin.activePromptTemplateSet
  const selected = admin.selectedPromptTemplateSet
  return selected && selected.id === viewingSetId.value ? selected : null
})

const entries = computed<PromptTemplateEntryRow[]>(
  () => (viewingSet.value?.entries ?? []) as PromptTemplateEntryRow[],
)

const history = computed<PromptTemplateSetRow[]>(() =>
  ([...admin.promptTemplateSets] as PromptTemplateSetRow[]).sort((a, b) => b.version - a.version),
)

const hasAnySet = computed(
  () => !!admin.activePromptTemplateSet || admin.promptTemplateSets.length > 0,
)

const isViewingHistory = computed(
  () => !!viewingSetId.value && viewingSetId.value !== admin.activePromptTemplateSet?.id,
)

/** Entries are only editable on the active set; history versions are read-only. */
const canEditEntries = computed(() => !!viewingSet.value && !isViewingHistory.value)

// ---- Instruction expansion ----
const expandedInstructions = ref<Set<string>>(new Set())

function isExpanded(id: string) {
  return expandedInstructions.value.has(id)
}

function toggleExpanded(id: string) {
  const next = new Set(expandedInstructions.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedInstructions.value = next
}

function truncate(text: string, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ---- Entry add/edit ----
const showEntryDialog = ref(false)
const editingEntry = ref<PromptTemplateEntryDto | null>(null)
const entrySaving = ref(false)
const entryError = ref('')
const entryForm = ref({ name: '', description: '', instruction: '', sortOrder: '' })

function openCreateEntry() {
  if (!canEditEntries.value) {
    toast('历史版本只读，请返回当前生效版本后再添加条目', 'error')
    return
  }
  editingEntry.value = null
  entryError.value = ''
  entryForm.value = { name: '', description: '', instruction: '', sortOrder: '' }
  showEntryDialog.value = true
}

function openEditEntry(entry: PromptTemplateEntryDto) {
  if (!canEditEntries.value) {
    toast('历史版本只读，请返回当前生效版本后再编辑条目', 'error')
    return
  }
  editingEntry.value = entry
  entryError.value = ''
  entryForm.value = {
    name: entry.name,
    description: entry.description,
    instruction: entry.instruction,
    sortOrder: String(entry.sortOrder),
  }
  showEntryDialog.value = true
}

function parseSortOrder(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function handleSaveEntry() {
  if (isViewingHistory.value) {
    entryError.value = '历史版本只读，请返回当前生效版本后再操作'
    return
  }
  const targetSetId = viewingSet.value?.id
  if (!targetSetId) {
    entryError.value = '没有可写入的模板版本，请先导入一个版本'
    return
  }
  if (!entryForm.value.name.trim()) {
    entryError.value = '请填写模板名称'
    return
  }
  if (!entryForm.value.instruction.trim()) {
    entryError.value = '请填写指令内容'
    return
  }
  entrySaving.value = true
  entryError.value = ''
  const payload = {
    name: entryForm.value.name.trim(),
    description: entryForm.value.description,
    instruction: entryForm.value.instruction,
    ...(parseSortOrder(entryForm.value.sortOrder) !== undefined
      ? { sortOrder: parseSortOrder(entryForm.value.sortOrder) as number }
      : {}),
  }
  const res = editingEntry.value
    ? await admin.updatePromptTemplateEntry(editingEntry.value.id, payload)
    : await admin.createPromptTemplateEntry(targetSetId, payload)
  entrySaving.value = false
  if (res.success && res.data) {
    showEntryDialog.value = false
    viewingSetId.value = res.data.id
    toast(editingEntry.value ? '模板条目已更新（已生成新版本）' : '模板条目已添加（已生成新版本）', 'success')
  } else {
    entryError.value = res.error?.message || '保存失败'
  }
}

// ---- Entry delete ----
const deleteEntryTarget = ref<PromptTemplateEntryDto | null>(null)

async function confirmDeleteEntry() {
  const target = deleteEntryTarget.value
  if (!target) return
  if (isViewingHistory.value) {
    deleteEntryTarget.value = null
    toast('历史版本只读，请返回当前生效版本后再操作', 'error')
    return
  }
  const res = await admin.deletePromptTemplateEntry(target.id)
  deleteEntryTarget.value = null
  if (res.success && res.data) {
    viewingSetId.value = res.data.setId
    toast(`「${target.name}」已删除（已生成新版本）`, 'success')
  }
  else toast(res.error?.message || '删除失败', 'error')
}

// ---- Version history ----
async function viewSet(id: string) {
  viewingSetId.value = id
  detailError.value = ''
  if (admin.selectedPromptTemplateSet?.id === id) return
  detailLoading.value = true
  try {
    const res = await admin.fetchPromptTemplateSetDetail(id)
    if (!res.success) detailError.value = res.error?.message || '加载版本详情失败'
  } catch {
    detailError.value = '加载版本详情失败'
  } finally {
    detailLoading.value = false
  }
}

function backToActive() {
  viewingSetId.value = null
  detailError.value = ''
}

const activatingId = ref<string | null>(null)

async function handleActivate(set: PromptTemplateSetSummaryDto) {
  activatingId.value = set.id
  const res = await admin.activatePromptTemplateSet(set.id)
  activatingId.value = null
  if (res.success) {
    viewingSetId.value = null
    toast(`已切换到「${set.name}」v${set.version}`, 'success')
  } else {
    toast(res.error?.message || '设为生效失败', 'error')
  }
}

const deleteSetTarget = ref<PromptTemplateSetSummaryDto | null>(null)

async function confirmDeleteSet() {
  const target = deleteSetTarget.value
  if (!target) return
  const res = await admin.deletePromptTemplateSet(target.id)
  deleteSetTarget.value = null
  if (res.success) {
    if (viewingSetId.value === target.id) viewingSetId.value = null
    toast(`版本 v${target.version} 已删除`, 'success')
  } else {
    toast(res.error?.message || '删除失败', 'error')
  }
}

// ---- Import ----
const showImportDialog = ref(false)
const importName = ref('')
const importActivate = ref(true)
const importing = ref(false)
const importError = ref('')
const importNote = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const stagedEntries = ref<StagedPromptTemplateEntry[]>([])
const stagedNames = ref<string[]>([])
const parseError = ref('')
const parseItemErrors = ref<string[]>([])
const parseWarnings = ref<string[]>([])

function openImport() {
  importError.value = ''
  importNote.value = ''
  showImportDialog.value = true
}
function resetImportParse() {
  stagedEntries.value = []
  stagedNames.value = []
  parseError.value = ''
  parseItemErrors.value = []
  parseWarnings.value = []
}

async function handleFileChange(event: Event) {
  resetImportParse()
  importNote.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const raw = await file.text()
  const parsed = parseTemplateImportFile(raw)
  if (!parsed.ok) {
    parseError.value = parsed.error
    parseItemErrors.value = parsed.itemErrors.map((e) => e.message)
    return
  }
  stagedEntries.value = parsed.result.entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    instruction: entry.instruction,
    ...(entry.path ? { path: entry.path } : {}),
  }))
  stagedNames.value = parsed.result.entries.map((e) => e.name)
  if (parsed.result.name) importName.value = parsed.result.name
  parseWarnings.value = parsed.result.warnings
}

async function handleImport() {
  importError.value = ''
  importNote.value = ''
  if (stagedEntries.value.length === 0) {
    importError.value = '请先选择标准 JSON 文件并通过本地解析'
    return
  }
  importing.value = true
  const res = await admin.importPromptTemplateSet(
    buildImportPromptTemplateSetInput(stagedEntries.value, {
      name: importName.value,
      activate: importActivate.value,
    }),
  )
  importing.value = false
  if (res.success && res.data) {
    importNote.value = `已导入 ${res.data.entryCount} 条模板（「${res.data.name}」v${res.data.version}${res.data.isActive ? '，已生效' : ''}）`
    viewingSetId.value = null
    if (fileInput.value) fileInput.value.value = ''
    resetImportParse()
  } else {
    importError.value = res.error?.message || '导入失败'
  }
}

// ---- Export ----
const exporting = ref(false)

async function handleExport() {
  const setId = viewingSet.value?.id
  if (!setId) {
    toast('没有可导出的模板版本', 'error')
    return
  }
  exporting.value = true
  const res = await admin.exportPromptTemplateSet(setId)
  exporting.value = false
  if (res.success) toast(`已导出 ${res.data.filename}`, 'success')
  else toast(res.error?.message || '导出失败', 'error')
}

// ---- Preview ----
const previewInstruction = ref('')
const previewValues = ref<Record<string, string>>({})
const previewLoading = ref(false)
const previewError = ref('')
const previewResult = ref<RenderPromptTemplateResult | null>(null)

const instructionVariables = computed(() => extractTemplateVariables(previewInstruction.value))

const unknownVariables = computed(() =>
  instructionVariables.value.filter(
    (name) => !(ALLOWED_PROMPT_TEMPLATE_VARS as readonly string[]).includes(name),
  ),
)

function setPreviewInstruction(instruction: string) {
  previewInstruction.value = instruction
  previewResult.value = null
  previewError.value = ''
}

async function handlePreview() {
  previewError.value = ''
  if (!previewInstruction.value.trim()) {
    previewError.value = '请先填写要预览的指令内容'
    return
  }
  previewLoading.value = true
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(previewValues.value)) {
    if (value) values[key] = value
  }
  const res = await admin.previewPromptTemplate({
    instruction: previewInstruction.value,
    values,
  })
  previewLoading.value = false
  if (res.success && res.data) previewResult.value = res.data
  else previewError.value = res.error?.message || '预览失败'
}

function useEntryForPreview(entry: PromptTemplateEntryDto) {
  setPreviewInstruction(entry.instruction)
  void handlePreview()
}

// ---- Initial load ----
onMounted(async () => {
  loading.value = true
  loadError.value = ''
  try {
    const [activeRes, setsRes] = await Promise.all([
      admin.fetchActivePromptTemplateSet(),
      admin.fetchPromptTemplateSets(),
    ])
    const failed = !activeRes.success ? activeRes : !setsRes.success ? setsRes : null
    if (failed) loadError.value = failed.error?.message || '加载提示词模板失败'
  } catch {
    loadError.value = '加载提示词模板失败'
  } finally {
    loading.value = false
  }
})

async function retryLoad() {
  loading.value = true
  loadError.value = ''
  try {
    const [activeRes, setsRes] = await Promise.all([
      admin.fetchActivePromptTemplateSet(),
      admin.fetchPromptTemplateSets(),
    ])
    if (!activeRes.success || !setsRes.success) {
      loadError.value =
        (!activeRes.success ? activeRes.error?.message : setsRes.error?.message) || '加载提示词模板失败'
    }
  } catch {
    loadError.value = '加载提示词模板失败'
  } finally {
    loading.value = false
  }
}

function fmtDate(iso?: string | null) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function shortDigest(digest: string | null) {
  if (!digest) return '—'
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest
}

const entryColumns: Column<PromptTemplateEntryRow>[] = [
  { key: 'name', label: '名称' },
  { key: 'description', label: '描述' },
  { key: 'instruction', label: '指令内容' },
  { key: 'sortOrder', label: '排序', render: (row) => String(row.sortOrder) },
]

const historyColumns: Column<PromptTemplateSetRow>[] = [
  { key: 'version', label: '版本', render: (row) => `v${row.version}` },
  { key: 'name', label: '名称' },
  { key: 'entryCount', label: '条目数', render: (row) => String(row.entryCount) },
  { key: 'isActive', label: '状态' },
  { key: 'updatedAt', label: '更新时间', render: (row) => fmtDate(row.updatedAt) },
]
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="提示词模板"
      description="管理数据库中的版本化提示词模板集：查看当前生效版本、增删模板条目、导入导出标准 JSON、渲染预览，以及切换或清理历史版本。"
    >
      <template #actions>
        <BaseButton variant="secondary" :loading="exporting" :disabled="!viewingSet" @click="handleExport">
          {{ exporting ? '导出中…' : '导出当前版本' }}
        </BaseButton>
        <BaseButton variant="primary" @click="openImport">导入新版本</BaseButton>
      </template>
    </PageHeader>

    <div v-if="loading" class="py-12 text-center text-xs text-muted-foreground">加载中…</div>

    <div v-else-if="loadError" class="space-y-3">
      <AppAlert type="error" title="加载失败" :message="loadError" />
      <BaseButton variant="secondary" size="sm" @click="retryLoad">重试</BaseButton>
    </div>

    <div v-else-if="!hasAnySet">
      <EmptyState
        title="暂无提示词模板"
        description="导入一份标准 JSON（{name, version, templates: [{name, description, instruction}]}）即可创建第一个版本。"
      >
        <template #action>
          <BaseButton size="sm" @click="openImport">导入新版本</BaseButton>
        </template>
      </EmptyState>
    </div>

    <template v-else>
      <!-- Active version summary -->
      <section aria-label="当前版本" class="rounded-[var(--radius-card)] border border-border bg-surface p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-sm font-semibold text-foreground">
            {{ viewingSet?.name || admin.activePromptTemplateSet?.name || '—' }}
          </h2>
          <Badge v-if="!isViewingHistory" tone="success">当前生效</Badge>
          <Badge v-else tone="warning">历史版本</Badge>
          <span class="text-xs text-muted-foreground">v{{ viewingSet?.version ?? '—' }}</span>
        </div>
        <dl class="mt-3 grid gap-3 text-xs md:grid-cols-4">
          <div>
            <dt class="text-muted-foreground">条目数</dt>
            <dd class="mt-1 text-foreground">{{ viewingSet?.entryCount ?? 0 }} 条</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">内容摘要</dt>
            <dd class="mt-1 font-mono text-foreground">{{ shortDigest(viewingSet?.contentDigest ?? null) }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">创建时间</dt>
            <dd class="mt-1 text-foreground">{{ fmtDate(viewingSet?.createdAt) }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">更新时间</dt>
            <dd class="mt-1 text-foreground">{{ fmtDate(viewingSet?.updatedAt) }}</dd>
          </div>
        </dl>
        <p v-if="isViewingHistory" class="mt-3 text-xs text-muted-foreground">
          正在查看历史版本，该版本只读；条目增删改请在当前生效版本中操作。
          <button class="text-xs text-foreground underline hover:no-underline" @click="backToActive">
            返回当前生效版本
          </button>
        </p>
        <p v-else class="mt-3 text-xs text-muted-foreground">
          条目增删改不会直接修改历史版本，而是基于当前版本生成新版本；设为生效后同步提升引导配置版本。
        </p>
      </section>

      <AppAlert v-if="detailError" type="error" title="加载版本详情失败" :message="detailError" />

      <!-- Entries -->
      <section aria-label="模板条目" class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-foreground">模板条目（{{ entries.length }}）</h2>
          <BaseButton variant="secondary" size="sm" :disabled="!canEditEntries" @click="openCreateEntry">
            添加条目
          </BaseButton>
        </div>
        <div v-if="detailLoading" class="py-8 text-center text-xs text-muted-foreground">版本详情加载中…</div>
        <DataTable
          v-else
          :columns="entryColumns"
          :data="entries"
          :row-key="(row: PromptTemplateEntryRow) => row.id"
          empty-text="该版本暂无模板条目"
        >
          <template #cell-description="{ row }">
            <span class="text-muted-foreground">{{ row.description || '—' }}</span>
          </template>
          <template #cell-instruction="{ row }">
            <div class="max-w-xl">
              <pre class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{{ isExpanded(row.id) ? row.instruction : truncate(row.instruction) }}</pre>
              <button
                v-if="row.instruction.length > 160"
                class="mt-1 text-xs text-foreground underline hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                :aria-expanded="isExpanded(row.id)"
                @click="toggleExpanded(row.id)"
              >
                {{ isExpanded(row.id) ? '收起' : '展开' }}
              </button>
            </div>
          </template>
          <template #mobile-card="{ row }">
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <p class="text-sm font-medium text-foreground">{{ row.name }}</p>
                <span class="text-xs text-muted-foreground">#{{ row.sortOrder }}</span>
              </div>
              <p v-if="row.description" class="text-xs text-muted-foreground">{{ row.description }}</p>
              <pre class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{{ isExpanded(row.id) ? row.instruction : truncate(row.instruction) }}</pre>
              <button
                v-if="row.instruction.length > 160"
                class="text-xs text-foreground underline hover:no-underline"
                :aria-expanded="isExpanded(row.id)"
                @click="toggleExpanded(row.id)"
              >
                {{ isExpanded(row.id) ? '收起' : '展开' }}
              </button>
              <div class="flex items-center gap-3 pt-1">
                <button class="text-xs text-foreground underline hover:no-underline" @click="useEntryForPreview(row)">预览</button>
                <button class="text-xs text-foreground underline hover:no-underline disabled:opacity-50" :disabled="!canEditEntries" @click="openEditEntry(row)">编辑</button>
                <button class="text-xs text-danger underline hover:no-underline disabled:opacity-50" :disabled="!canEditEntries" @click="deleteEntryTarget = row">删除</button>
              </div>
            </div>
          </template>
          <template #actions="{ row }">
            <div class="flex items-center justify-end gap-3">
              <button class="text-xs text-foreground hover:underline" @click="useEntryForPreview(row)">预览</button>
              <button class="text-xs text-foreground hover:underline disabled:opacity-50 disabled:hover:no-underline" :disabled="!canEditEntries" @click="openEditEntry(row)">编辑</button>
              <button class="text-xs text-danger hover:underline disabled:opacity-50 disabled:hover:no-underline" :disabled="!canEditEntries" @click="deleteEntryTarget = row">删除</button>
            </div>
          </template>
        </DataTable>
      </section>

      <!-- Preview -->
      <section aria-label="渲染预览" class="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface p-4">
        <h2 class="text-sm font-semibold text-foreground">渲染预览</h2>
        <Field label="指令内容" hint="支持 {{input_prompt}} 等模板变量，提交后由服务端渲染。">
          <Textarea
            :model-value="previewInstruction"
            :rows="5"
            placeholder="粘贴或从上方条目载入指令内容…"
            spellcheck="false"
            class="font-mono text-xs"
            @update:model-value="setPreviewInstruction"
          />
        </Field>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field
            v-for="name in ALLOWED_PROMPT_TEMPLATE_VARS"
            :key="name"
            :label="`{{${name}}}`"
          >
            <TextInput v-model="previewValues[name]" type="text" :placeholder="`输入 ${name} 的值`" />
          </Field>
        </div>
        <AppAlert
          v-if="unknownVariables.length > 0"
          type="warning"
          :message="`指令中使用了未知变量：${unknownVariables.map((n) => `{{${n}}}`).join('、')}，服务端可能拒绝渲染`"
        />
        <div>
          <BaseButton
            variant="secondary"
            size="sm"
            :loading="previewLoading"
            :disabled="!previewInstruction.trim()"
            @click="handlePreview"
          >
            {{ previewLoading ? '渲染中…' : '渲染预览' }}
          </BaseButton>
        </div>
        <AppAlert v-if="previewError" type="error" title="预览失败" :message="previewError" />
        <div v-if="previewResult" class="space-y-2">
          <pre class="whitespace-pre-wrap break-words rounded-[var(--radius-control)] border border-border bg-background p-3 font-mono text-xs text-foreground">{{ previewResult.rendered }}</pre>
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-xs text-muted-foreground">已使用变量：</span>
            <Badge v-for="name in previewResult.usedVariables" :key="name" tone="info">{{ name }}</Badge>
            <span v-if="previewResult.usedVariables.length === 0" class="text-xs text-muted-foreground">无</span>
          </div>
          <AppAlert v-if="previewResult.hasUnresolvedVariables" type="warning" message="仍有未赋值的模板变量，未赋值的变量按空字符串渲染。" />
        </div>
      </section>

      <!-- Version history -->
      <section aria-label="版本历史" class="space-y-3">
        <h2 class="text-sm font-semibold text-foreground">版本历史（{{ history.length }}）</h2>
        <DataTable
          :columns="historyColumns"
          :data="history"
          :row-key="(row: PromptTemplateSetRow) => row.id"
          empty-text="暂无历史版本"
        >
          <template #cell-name="{ row }">
            <button
              class="text-foreground underline hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              :aria-label="`查看版本 v${row.version} 的详情`"
              @click="viewSet(row.id)"
            >
              {{ row.name }}
            </button>
          </template>
          <template #cell-isActive="{ row }">
            <Badge :tone="row.isActive ? 'success' : 'neutral'">{{ row.isActive ? '生效中' : '历史' }}</Badge>
          </template>
          <template #mobile-card="{ row }">
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <p class="text-sm font-medium text-foreground">{{ row.name }} · v{{ row.version }}</p>
                <Badge :tone="row.isActive ? 'success' : 'neutral'">{{ row.isActive ? '生效中' : '历史' }}</Badge>
              </div>
              <p class="text-xs text-muted-foreground">{{ row.entryCount }} 条 · {{ fmtDate(row.updatedAt) }}</p>
              <div class="flex items-center gap-3 pt-1">
                <button class="text-xs text-foreground underline hover:no-underline" @click="viewSet(row.id)">查看</button>
                <button
                  class="text-xs text-foreground underline hover:no-underline disabled:opacity-50"
                  :disabled="row.isActive || activatingId === row.id"
                  @click="handleActivate(row)"
                >
                  {{ activatingId === row.id ? '切换中…' : '设为生效' }}
                </button>
                <button
                  class="text-xs text-danger underline hover:no-underline disabled:opacity-50"
                  :disabled="row.isActive"
                  @click="deleteSetTarget = row"
                >
                  删除
                </button>
              </div>
            </div>
          </template>
          <template #actions="{ row }">
            <div class="flex items-center justify-end gap-3">
              <button class="text-xs text-foreground hover:underline" @click="viewSet(row.id)">查看</button>
              <button
                class="text-xs text-foreground hover:underline disabled:opacity-50 disabled:hover:no-underline"
                :disabled="row.isActive || activatingId === row.id"
                @click="handleActivate(row)"
              >
                {{ activatingId === row.id ? '切换中…' : '设为生效' }}
              </button>
              <button
                class="text-xs text-danger hover:underline disabled:opacity-50 disabled:hover:no-underline"
                :disabled="row.isActive"
                @click="deleteSetTarget = row"
              >
                删除
              </button>
            </div>
          </template>
        </DataTable>
      </section>
    </template>

    <!-- Entry dialog -->
    <AppModal v-model:open="showEntryDialog" size="lg" :title="editingEntry ? '编辑模板条目' : '添加模板条目'">
      <div class="space-y-3">
        <p v-if="editingEntry" class="text-xs text-muted-foreground">
          保存后将基于「{{ viewingSet?.name }}」v{{ viewingSet?.version }} 生成新版本，历史版本保持不变。
        </p>
        <Field label="模板名称" required>
          <TextInput v-model="entryForm.name" type="text" placeholder="例如：通用图像增强" />
        </Field>
        <Field label="描述">
          <TextInput v-model="entryForm.description" type="text" placeholder="一句话说明该模板的用途（可选）" />
        </Field>
        <Field label="指令内容" required hint="支持 {{input_prompt}} 等模板变量；保存后以新版本生效。">
          <Textarea
            v-model="entryForm.instruction"
            :rows="8"
            placeholder="输入提示词模板指令…"
            spellcheck="false"
            class="font-mono text-xs"
          />
        </Field>
        <Field label="排序" hint="数字越小越靠前，留空由服务端安排。">
          <TextInput v-model="entryForm.sortOrder" type="text" inputmode="numeric" placeholder="例如：0" />
        </Field>
        <div v-if="entryError" class="text-xs text-danger" role="alert">{{ entryError }}</div>
      </div>
      <template #footer="{ close }">
        <BaseButton variant="secondary" @click="close">取消</BaseButton>
        <BaseButton
          variant="primary"
          :disabled="entrySaving || !entryForm.name.trim() || !entryForm.instruction.trim()"
          :loading="entrySaving"
          @click="handleSaveEntry"
        >
          {{ entrySaving ? '保存中…' : editingEntry ? '保存并生成新版本' : '添加并生成新版本' }}
        </BaseButton>
      </template>
    </AppModal>

    <!-- Import dialog -->
    <AppModal v-model:open="showImportDialog" size="lg" title="导入新版本">
      <div class="space-y-3">
        <p class="text-xs text-muted-foreground">
          选择标准 JSON 文件（顶层数组，或包含 templates 数组的对象；每条含 name / description / instruction）。
          文件先在本地解析预检，通过后提交到服务端创建新版本。
        </p>
        <Field label="版本名称（可选）" hint="从文件顶层 name 自动填入，可修改；留空由服务端命名。">
          <TextInput v-model="importName" type="text" placeholder="例如：2026 秋季模板" />
        </Field>
        <div class="flex items-center gap-2">
          <PillToggle v-model="importActivate" />
          <span class="text-xs font-medium text-foreground">导入后设为生效</span>
        </div>
        <div>
          <label for="prompt-template-import-file" class="mb-1 block text-xs font-medium text-foreground">
            标准 JSON 文件
          </label>
          <input
            id="prompt-template-import-file"
            ref="fileInput"
            type="file"
            accept="application/json,.json"
            class="block w-full text-xs text-foreground file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-border file:bg-surface-subtle file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            @change="handleFileChange"
          />
        </div>
        <div v-if="stagedNames.length > 0" class="rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2">
          <p class="text-xs font-medium text-foreground">
            已解析 {{ stagedNames.length }} 条：{{ stagedNames.slice(0, 5).join('、') }}{{ stagedNames.length > 5 ? '…' : '' }}
          </p>
        </div>
        <AppAlert v-if="parseError" type="error" title="解析失败" :message="parseError" />
        <ul v-if="parseItemErrors.length > 0" class="space-y-1">
          <li v-for="(message, i) in parseItemErrors" :key="i" class="text-xs text-danger" role="alert">{{ message }}</li>
        </ul>
        <div v-if="parseWarnings.length > 0" class="max-h-32 space-y-1 overflow-y-auto">
          <AppAlert v-for="(warning, i) in parseWarnings" :key="i" type="warning" :message="warning" />
        </div>
        <AppAlert v-if="importError" type="error" title="导入失败" :message="importError" />
        <AppAlert v-if="importNote" type="success" :message="importNote" />
      </div>
      <template #footer="{ close }">
        <BaseButton variant="secondary" @click="close">关闭</BaseButton>
        <BaseButton
          variant="primary"
          :disabled="importing || stagedEntries.length === 0"
          :loading="importing"
          @click="handleImport"
        >
          {{ importing ? '导入中…' : stagedEntries.length > 0 ? `导入 ${stagedEntries.length} 条` : '导入' }}
        </BaseButton>
      </template>
    </AppModal>

    <ConfirmDialog
      :open="!!deleteEntryTarget"
      title="删除模板条目"
      :description="`确认删除「${deleteEntryTarget?.name || ''}」？将基于当前版本生成不含该条目的新版本，历史版本保持不变。`"
      confirm-text="删除"
      variant="danger"
      @update:open="(v: boolean) => { if (!v) deleteEntryTarget = null }"
      @confirm="confirmDeleteEntry"
    />

    <ConfirmDialog
      :open="!!deleteSetTarget"
      title="删除历史版本"
      :description="`确认删除「${deleteSetTarget?.name || ''}」v${deleteSetTarget?.version ?? ''}？该版本及条目将被永久删除，生效中的版本不可删除。`"
      confirm-text="删除"
      variant="danger"
      @update:open="(v: boolean) => { if (!v) deleteSetTarget = null }"
      @confirm="confirmDeleteSet"
    />
  </div>
</template>
