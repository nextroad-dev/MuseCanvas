'use client'

import { ArrowSquareOutIcon as Export, CheckIcon, DownloadSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import type { PromptTemplateSetDetailDto, PromptTemplateSetSummaryDto } from '@musecanvas/contracts'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { EmptyState } from '@/shared/components/ui/empty-state'
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
import { truncateText } from '@/shared/lib/format'

export interface AdminPromptSetsCardProps {
  active: PromptTemplateSetDetailDto | null
  sets: PromptTemplateSetSummaryDto[]
  selectedId: string | null
  busySetId: string | null
  exportHref: (setId?: string) => string
  onSelect: (id: string) => void
  onActivate: (id: string) => void
  onDelete: (set: PromptTemplateSetSummaryDto) => void
}

/**
 * 激活集摘要 + 全部模板集列表。
 *
 * 模板是 copy-on-write 的：每次编辑都会生成新版本，所以列表同时是历史版本入口；
 * 启用中的版本不可删除（后端 `CANNOT_DELETE_ACTIVE_SET`），这里直接禁用按钮。
 */
export function AdminPromptSetsCard({
  active,
  sets,
  selectedId,
  busySetId,
  exportHref,
  onSelect,
  onActivate,
  onDelete,
}: AdminPromptSetsCardProps) {
  return (
    <Card aria-labelledby="admin-prompt-sets-title">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle id="admin-prompt-sets-title" level={2}>
            模板集
          </CardTitle>
          <Badge tone="neutral">{sets.length} 个版本</Badge>
          {active ? <Badge tone="success" dot>已启用 v{active.version}</Badge> : <Badge tone="warning">无启用版本</Badge>}
        </div>
        <CardDescription>
          提示词模板按“集”版本化管理：编辑条目会自动派生新版本并保持启用状态，历史版本仍可查看、导出或回滚启用。
        </CardDescription>
      </CardHeader>

      <CardBody>
        {active ? (
          <div className="flex flex-col gap-3 rounded-control bg-tonal p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-module text-foreground">{active.name}</span>
              <Badge tone="success" dot>
                启用中
              </Badge>
              <Badge tone="neutral">v{active.version}</Badge>
              <Badge tone="neutral">{active.entryCount} 条模板</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
              <span>更新于 {formatDateTime(active.updatedAt)}</span>
              {active.contentDigest ? <span>摘要 {active.contentDigest.slice(0, 12)}</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => onSelect(active.id)}>
                查看条目
              </Button>
              <a
                href={exportHref(active.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[var(--control-sm)] items-center gap-1.5 rounded-control px-3 text-sm text-foreground transition-colors hover:bg-tonal-hover"
              >
                导出当前集
                <DownloadSimpleIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
              </a>
            </div>
          </div>
        ) : (
          <EmptyState
            density="compact"
            title="还没有启用中的模板集"
            description="导入一份模板集并启用后，才会参与生成时的提示词渲染。"
          />
        )}

        <Table caption="提示词模板集版本列表" columns={6}>
          <TableHeader>
            <TableHeadCell>名称</TableHeadCell>
            <TableHeadCell>版本</TableHeadCell>
            <TableHeadCell>条目</TableHeadCell>
            <TableHeadCell>状态</TableHeadCell>
            <TableHeadCell>更新时间</TableHeadCell>
            <TableHeadCell align="right">操作</TableHeadCell>
          </TableHeader>
          <TableBody busy={busySetId !== null}>
            {sets.length === 0 ? (
              <TableStateRow>
                <EmptyState density="compact" title="暂无模板集" description="使用「导入模板集」上传 JSON 或粘贴内容创建第一份。" />
              </TableStateRow>
            ) : (
              sets.map((set) => {
                const selected = set.id === selectedId
                const busy = busySetId === set.id
                return (
                  <TableRow key={set.id} hover>
                    <TableCell tone={selected ? 'strong' : 'default'}>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate" title={set.name}>
                          {truncateText(set.name, 40)}
                        </span>
                        {selected ? <span className="text-xs text-muted-foreground">当前查看</span> : null}
                      </div>
                    </TableCell>
                    <TableCell mono tabular>
                      v{set.version}
                    </TableCell>
                    <TableCell mono tabular>
                      {set.entryCount}
                    </TableCell>
                    <TableCell>
                      {set.isActive ? <Badge tone="success" dot>启用中</Badge> : <Badge tone="neutral">历史版本</Badge>}
                    </TableCell>
                    <TableCell mono className="whitespace-nowrap">
                      {formatDateTime(set.updatedAt)}
                    </TableCell>
                    <TableCell align="right">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onSelect(set.id)} disabled={busy}>
                          查看
                        </Button>
                        {!set.isActive ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onActivate(set.id)}
                            loading={busy}
                            icon={<CheckIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
                          >
                            激活
                          </Button>
                        ) : null}
                        <a
                          href={exportHref(set.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`导出模板集 ${set.name}`}
                          className="inline-flex size-[var(--control-sm)] items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-tonal-hover hover:text-foreground"
                        >
                          <Export weight="bold" aria-hidden="true" className={iconSize.sm} />
                        </a>
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          aria-label={`删除模板集 ${set.name}`}
                          disabled={set.isActive || busy}
                          onClick={() => onDelete(set)}
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
      </CardBody>

      <CardFooter>
        <span className="text-xs text-muted-foreground">启用中的版本不能删除；回滚只需激活历史版本。</span>
      </CardFooter>
    </Card>
  )
}
