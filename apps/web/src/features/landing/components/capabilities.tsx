'use client'

import { useId, useState } from 'react'
import { PlusIcon } from '@phosphor-icons/react'
import { Reveal } from '@/shared/components/reveal'
import { iconSize } from '@/shared/components/ui/size'
import { cn } from '@/shared/lib/cn'
import { LandingFrame } from './landing-frame'

interface Capability {
  title: string
  description: string
}

const CAPABILITIES: Capability[] = [
  { title: '用大白话描述画面', description: '写清主体、场景和光线就行，不用套模板，也不用学专门的写法。' },
  { title: '随时换模型和画面比例', description: '在同一个页面里切换模型、画面比例和张数，换完马上能用。' },
  { title: '失败自动重试，也能取消', description: '任务排队依次生成，失败会自动再试；不想要了可以随时取消。' },
  { title: '作品自动存进图库', description: '画好的图自动保存，可以放大查看、下载原图，或批量删除。' },
  { title: '邮箱验证码登录', description: '输入邮箱、收验证码就能登录，也支持 GitHub 和 Google 账号。' },
  { title: '可以装在自己的服务器上', description: '按向导一步步完成安装；用户、模型和登录方式都在后台管理。' },
]

/**
 * 能力区（画板 01 / 04）：左栏衬线标题，右栏单开手风琴。
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
        <LandingFrame className="flex flex-wrap items-start gap-x-20 gap-y-5 py-6 md:gap-y-12 md:py-32">
          <div className="flex min-w-0 max-w-[400px] flex-[1_1_320px] flex-col gap-5">
            <h2
              id="cap-title"
              className="text-sm font-medium text-foreground/80 sm:font-display sm:text-headline sm:font-semibold sm:text-foreground"
            >
              能力
            </h2>
            <p className="font-display text-headline font-semibold text-foreground sm:text-section sm:font-medium">
              写、画、存，<br className="sm:hidden" />
              都在一个页面
            </p>
            <p className="max-sm:hidden text-module font-normal text-foreground/80">从描述画面到找回旧图，不用切换其他工具。</p>
          </div>

          <ul className="m-0 min-w-0 flex-[999_1_560px] list-none border-t border-foreground p-0">
            {CAPABILITIES.map((capability, index) => {
              const open = openIndex === index
              const triggerId = `${idPrefix}-trigger-${index}`
              const panelId = `${idPrefix}-panel-${index}`
              return (
                <li key={capability.title} className="border-b border-border">
                  <h3 className="m-0">
                    <button
                      type="button"
                      id={triggerId}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setOpenIndex(open ? -1 : index)}
                      className={cn(
                        'motion-press flex w-full items-center justify-between gap-6 border-0 bg-transparent py-[26px] text-left',
                        'font-display text-statement font-semibold text-foreground',
                        'max-sm:min-h-[var(--control-xl)] max-sm:py-0 max-sm:text-lead max-sm:font-semibold',
                      )}
                    >
                      <span>{capability.title}</span>
                      <PlusIcon
                        weight="regular"
                        aria-hidden="true"
                        className={cn(
                          iconSize.md,
                          'shrink-0 transition-transform duration-[var(--motion-base)]',
                          open && 'rotate-45',
                        )}
                      />
                    </button>
                  </h3>
                  {open ? (
                    <p
                      id={panelId}
                      aria-labelledby={triggerId}
                      className="m-0 pb-7 pr-12 text-module font-normal leading-[1.75] text-foreground/80 max-sm:pb-4 max-sm:pr-0 max-sm:text-compact"
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
