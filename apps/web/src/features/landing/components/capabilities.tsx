'use client'

import { useId, useState } from 'react'
import {
  ArrowsClockwiseIcon,
  ChatTextIcon,
  EnvelopeSimpleIcon,
  FolderSimpleStarIcon,
  HardDrivesIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
} from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { Reveal } from '@/shared/components/reveal'
import { iconSize } from '@/shared/components/ui/size'
import { cn } from '@/shared/lib/cn'
import { LandingFrame } from './landing-frame'

interface Capability {
  icon: PhosphorIcon
  title: string
  description: string
}

const CAPABILITIES: Capability[] = [
  {
    icon: ChatTextIcon,
    title: '用大白话描述画面',
    description: '写清主体、场景和光线就行，不用套模板，也不用学专门的写法。',
  },
  {
    icon: SlidersHorizontalIcon,
    title: '随时换模型和画面比例',
    description: '在同一个页面里切换模型、画面比例和张数，换完马上能用。',
  },
  {
    icon: ArrowsClockwiseIcon,
    title: '失败自动重试，也能取消',
    description: '任务排队依次生成，失败会自动再试；不想要了可以随时取消。',
  },
  {
    icon: FolderSimpleStarIcon,
    title: '作品自动存进图库',
    description: '画好的图自动保存，可以放大查看、下载原图，或批量删除。',
  },
  {
    icon: EnvelopeSimpleIcon,
    title: '邮箱验证码登录',
    description: '输入邮箱、收验证码就能登录，也支持 GitHub 和 Google 账号。',
  },
  {
    icon: HardDrivesIcon,
    title: '可以装在自己的服务器上',
    description: '按向导一步步完成安装；用户、模型和登录方式都在后台管理。',
  },
]

/**
 * 能力区：左栏 studio 标题与声明，右栏 Bento 风格单开手风琴卡片。
 *
 * 手风琴是唯一需要状态的 island：一次只开一行，点已展开的行收起；
 * `+` 号旋转 45° 表示开关，按钮带 aria-expanded / aria-controls。
 */
export function Capabilities() {
  const [openIndex, setOpenIndex] = useState(0)
  const idPrefix = useId()

  return (
    <section id="capabilities" aria-labelledby="cap-title" className="scroll-mt-20">
      <Reveal>
        <LandingFrame className="flex flex-wrap items-start gap-x-16 gap-y-8 py-16 md:py-28">
          <div className="flex min-w-0 max-w-[380px] flex-[1_1_300px] flex-col items-start gap-4">
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent-soft px-3 py-1 text-caption font-medium text-accent">
              <SparkleIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
              核心能力
            </span>
            <h2 id="cap-title" className="font-display text-headline text-foreground">
              能力
            </h2>
            <p className="font-display text-statement text-foreground">
              写、画、存，
              <br className="sm:hidden" />
              都在一个页面
            </p>
            <p className="text-copy text-muted-foreground max-sm:hidden">
              从描述画面到找回旧图，不用切换其他工具。
            </p>
          </div>

          <ul className="m-0 grid min-w-0 flex-[999_1_540px] list-none grid-cols-1 gap-3 p-0">
            {CAPABILITIES.map((capability, index) => {
              const open = openIndex === index
              const triggerId = `${idPrefix}-trigger-${index}`
              const panelId = `${idPrefix}-panel-${index}`
              const CapIcon = capability.icon

              return (
                <li
                  key={capability.title}
                  className={cn(
                    'rounded-card border bg-surface transition-colors',
                    open ? 'border-accent/40 shadow-soft' : 'border-border hover:border-border-strong',
                  )}
                >
                  <h3 className="m-0">
                    <button
                      type="button"
                      id={triggerId}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setOpenIndex(open ? -1 : index)}
                      className="motion-press flex w-full items-center justify-between gap-4 rounded-card border-0 bg-transparent px-5 py-4 text-left sm:px-6 sm:py-5"
                    >
                      <span className="flex min-w-0 items-center gap-3.5">
                        <span
                          className={cn(
                            'inline-flex size-9 shrink-0 items-center justify-center rounded-control transition-colors',
                            open ? 'bg-accent-soft text-accent' : 'bg-tonal text-muted-foreground',
                          )}
                        >
                          <CapIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
                        </span>
                        <span className="font-display text-module font-medium text-foreground sm:text-subtitle">
                          {capability.title}
                        </span>
                      </span>

                      <PlusIcon
                        weight="bold"
                        aria-hidden="true"
                        className={cn(
                          iconSize.md,
                          'shrink-0 text-muted-foreground transition-transform duration-[var(--motion-base)]',
                          open && 'rotate-45 text-accent',
                        )}
                      />
                    </button>
                  </h3>

                  {open ? (
                    <p
                      id={panelId}
                      aria-labelledby={triggerId}
                      className="m-0 px-5 pb-5 pl-[4.5rem] text-sm leading-relaxed text-muted-foreground sm:px-6 sm:pb-6 sm:pl-[4.75rem] sm:text-base"
                    >
                      {capability.description}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </LandingFrame>
      </Reveal>
    </section>
  )
}
