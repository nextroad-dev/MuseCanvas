'use client'

import {
  ArrowSquareOutIcon as Open,
  CaretDownIcon,
  CaretUpIcon,
  EyeIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import type { PromptTemplateEntryDto, PromptTemplateSetDetailDto } from '@musecanvas/contracts'
import { Alert } from '@/shared/components/ui/alert'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableStateRow,
} from '@/shared/components/ui/table'
import { iconSize } from '@/shared/components/ui/size'
import { formatDateTime } from '@/shared/lib/format'
import {
  sortPromptEntries,
  templateInstructionSummary,
  templateVariableSummary,
} from '@/features/admin/lib/admin-prompt-templates'

export interface AdminPromptEntriesCardProps {
  set: PromptTemplateSetDetailDto | null
  editable: boolean
  busyEntryId: string | null
  onAdd: () => void
  onEdit: (entry: PromptTemplateEntryDto) => void
  onDelete: (entry: PromptTemplateEntryDto) => void
  onPreview: (entry: PromptTemplateEntryDto) => void
  onMove: (entry: PromptTemplateEntryDto, direction: -1 | 1) => void
  onExport: () => void
}

/**
 * 条目表格：名称 / 描述 / 变量 / 排序 / 内容摘要 / 操作。
 *
 * 只有启用中的集可编辑（后端 copy-on-write 限制）；历史版本展示为只读并给出激活入口。
 */
export function AdminPromptEntriesCard({
  set,
  editable,
  busyEntryId,
  onAdd,
  onEdit,
  onDelete,
  onPreview,
  onMove,
  onExport,
}: AdminPromptEntriesCardProps) {
  const entries = set ? sortPromptEntries(set.entries) : []

  return (
    <Card aria-labelledby="admin-prompt-entries-title">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle id="admin-prompt-entries-title" level={2}>
            条目
          </CardTitle>
          {set ? (
            <>
              <Badge tone="neutral" dot>
                {set.name} · v{set.version}
              </Badge>
              <Badge tone={editable ? 'success' : 'neutral'}>{editable ? '可编辑' : '只读'}</Badge>
              <Badge tone="neutral">{entries.length} 条</Badge>
            </>
          ) : (
            <Badge tone="neutral">未选择模板集</Badge>
          )}
        </div>
        <CardDescription>
          每条模板是一段带 {'{{变量}}'} 占位符的指令；生成时按变量渲染成最终提示词。展示的是当前选中版本。
        </CardDescription>
      </CardHeader>

      <CardBody>
        {!set ? (
          <p className="text-sm text-muted-foreground">从上方列表选择一个模板集查看条目。</p>
        ) : null}

        {set && !editable ? (
          <Alert tone="info" title="该版本不是启用中的模板集">
            条目的新增、编辑、删除与排序只允许在启用版本上进行；激活该版本后即可编辑（会生成新的当前版本）。
          </Alert>
        ) : null}

        {set ? (
          <Table caption={`模板集 ${set.name} 的条目列表`} columns={6}>
            <TableHeader>
              <TableHeadCell>名称</TableHeadCell>
              <TableHeadCell>变量</TableHeadCell>
              <TableHeadCell>排序</TableHeadCell>
              <TableHeadCell className="hidden md:table-cell">内容摘要</TableHeadCell>
              <TableHeadCell className="hidden lg:table-cell">创建时间</TableHeadCell>
              <TableHeadCell align="right">操作</TableHeadCell>
            </TableHeader>
            <TableBody busy={busyEntryId !== null}>
              {entries.length === 0 ? (
                <TableStateRow>
                  <div className="flex flex-col items-center gap-2 py-6 text-center">
                    <p className="text-sm text-foreground">该模板集还没有条目</p>
                    <p className="text-sm text-muted-foreground">新增条目或重新导入一份模板集。</p>
                    {editable ? (
                      <Button size="sm" variant="secondary" onClick={onAdd}>
                        新增条目
                      </Button>
                    ) : null}
                  </div>
                </TableStateRow>
              ) : (
                entries.map((entry, index) => {
                  const busy = busyEntryId === entry.id
                  return (
                    <TableRow key={entry.id} hover>
                      <TableCell tone="strong">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate" title={entry.name}>
                            {entry.name}
                          </span>
                          {entry.description ? (
                            <span className="truncate text-xs text-muted-foreground" title={entry.description}>
                              {entry.description}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-40">
                        <span className="font-mono text-xs text-foreground" title={templateVariableSummary(entry.instruction)}>
                          {templateVariableSummary(entry.instruction)}
                        </span>
                      </TableCell>
                      <TableCell mono tabular>
                        <div className="flex items-center gap-1">
                          <span className="w-10">{entry.sortOrder}</span>
                          <span className="flex flex-col">
                            <button
                              type="button"
                              aria-label={`上移 ${entry.name}`}
                              disabled={!editable || index === 0 || busy}
                              onClick={() => onMove(entry, -1)}
                              className="rounded-[4px] text-muted-foreground transition-colors hover:bg-tonal-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                            >
                              <CaretUpIcon className={iconSize.xs} />
                            </button>
                            <button
                              type="button"
                              aria-label={`下移 ${entry.name}`}
                              disabled={!editable || index === entries.length - 1 || busy}
                              onClick={() => onMove(entry, 1)}
                              className="rounded-[4px] text-muted-foreground transition-colors hover:bg-tonal-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                            >
                              <CaretDownIcon className={iconSize.xs} />
                            </button>
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden max-w-64 md:table-cell">
                        <span className="text-xs text-muted-foreground">
                          {templateInstructionSummary(entry.instruction)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap lg:table-cell" mono>
                        {formatDateTime(entry.createdAt)}
                      </TableCell>
                      <TableCell align="right">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onPreview(entry)}
                            icon={<EyeIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
                          >
                            预览
                          </Button>
                          <Button variant="secondary" size="sm" disabled={!editable || busy} onClick={() => onEdit(entry)}>
                            编辑
                          </Button>
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            disabled={!editable || busy}
                            aria-label={`删除条目 ${entry.name}`}
                            onClick={() => onDelete(entry)}
                            icon={<TrashIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
                          >
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        ) : null}
      </CardBody>

      <CardFooter>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={onAdd}
            disabled={!editable}
            icon={<PlusIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            新增条目
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onExport}
            disabled={!set}
            icon={<Open weight="bold" aria-hidden="true" className={iconSize.sm} />}
          >
            导出当前版本
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          {editable ? '保存条目会自动派生新版本并保持启用。' : '先激活该版本才能编辑。'}
        </span>
      </CardFooter>
    </Card>
  )
}
