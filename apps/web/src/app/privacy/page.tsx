import Link from 'next/link'
import { ArrowUpIcon, ShieldCheckIcon } from '@phosphor-icons/react/ssr'
import { PublicShell } from '@/shared/components/shells'
import { Alert, Badge, Button, Card, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

export const dynamic = 'force-static'

export const metadata = {
  title: '隐私政策',
  description: 'MuseCanvas 隐私政策与数据保护说明',
}

const UPDATED_AT = '2026-06-25'

const PROSE_SECTIONS = cn(
  'flex flex-col p-6 sm:p-10',
  '[&>section]:flex [&>section]:flex-col [&>section]:gap-4 [&>section]:scroll-mt-20',
  '[&>section+section]:mt-10 [&>section+section]:border-t [&>section+section]:border-border [&>section+section]:pt-10',
  '[&>section>h2]:m-0 [&>section>h2]:font-display [&>section>h2]:text-section [&>section>h2]:font-semibold [&>section>h2]:text-foreground',
  '[&>section>p]:m-0 [&>section>p]:text-base [&>section>p]:text-foreground [&>section>p]:[overflow-wrap:break-word]',
  '[&>section>p>strong]:font-medium [&>section>p>strong]:text-foreground',
  '[&>section>ul]:m-0 [&>section>ul]:list-disc [&>section>ul]:space-y-1.5 [&>section>ul]:pl-5 [&>section>ul]:text-base [&>section>ul]:text-foreground',
  '[&>section>ul>li]:[overflow-wrap:break-word]',
)

/**
 * 隐私政策（/privacy）：严格 `force-static` SSG，由 `PublicShell`（`width="reading"` + `readingProgress`）
 * 统一顶栏、滚动进度条、72ch 阅读栏与页脚。
 */
export default function PrivacyPage() {
  return (
    <PublicShell current="privacy" width="reading" readingProgress>
      <article className="flex flex-col gap-8">
        <header className="flex flex-col items-start gap-4">
          <Badge
            tone="accent"
            variant="soft"
            icon={<ShieldCheckIcon weight="duotone" />}
            className="gap-1.5 px-3 py-1 font-mono text-caption uppercase tracking-[0.05em]"
          >
            MuseCanvas · 法律文件
          </Badge>
          <h1 className="m-0 font-display text-headline text-foreground">隐私政策</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <span>
              最后更新：
              <time dateTime={UPDATED_AT} className="font-mono tabular-nums text-foreground">
                {UPDATED_AT}
              </time>
            </span>
            <span aria-hidden="true" className="text-border-strong">
              ·
            </span>
            <Link
              href={APP_ROUTES.terms}
              className="rounded-control text-foreground underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-foreground"
            >
              查看用户协议
            </Link>
          </div>
        </header>

        <Card variant="surface" density="none" className={cn('rounded-panel', PROSE_SECTIONS)}>
          <section id="notice">
            <h2>适用对象与地域限制</h2>
            <Alert tone="warning" title="本服务不面向中国大陆用户。" icon={false}>
              <div className="flex flex-col gap-2">
                <p>
                  我们不向位于中国大陆境内的用户提供本服务，亦不接受来自中国大陆的注册、访问与使用。
                </p>
                <p>
                  如你位于中国大陆，请勿访问、使用本服务或向我们提供任何个人信息；本政策其他条款以本条适用对象范围为前提，对不属于本服务适用对象的用户不适用。
                </p>
              </div>
            </Alert>
          </section>

          <section id="section-1">
            <h2>一、信息收集</h2>
            <p>为提供与改进服务，我们可能收集以下信息：</p>
            <ul>
              <li>账户信息：邮箱地址、邀请码、第三方登录授权信息；</li>
              <li>使用数据：你输入的提示词与生成参数、生成的图像结果、任务记录；</li>
              <li>日志信息：IP 地址、访问时间、设备与浏览器信息等技术日志。</li>
            </ul>
          </section>

          <section id="section-2">
            <h2>二、信息用途</h2>
            <p>我们将上述信息用于：</p>
            <ul>
              <li>提供图像生成、账户管理与任务记录功能；</li>
              <li>保障账户与系统安全、排查故障与防范滥用；</li>
              <li>分析并改进服务功能与性能。</li>
            </ul>
          </section>

          <section id="section-3">
            <h2>三、第三方共享与数据训练</h2>
            <p>
              本服务的图像生成能力由我们合作的第三方模型与服务供应商提供，<strong>包括但不限于 OpenAI、火山引擎等</strong>。为完成你的生成请求，我们会将提示词及相关数据共享给上述第三方处理。
            </p>
            <p>
              <strong>上述第三方可能将收到的数据用于其自身的服务运营与模型训练。</strong>
              数据在第三方处的收集、使用与保护，受相应第三方的隐私政策约束，我们无法完全控制其处理行为。
            </p>
            <p>你理解并同意上述共享与处理安排。如不接受，请勿使用相关功能。详细信息可参阅各第三方隐私政策。</p>
          </section>

          <section id="section-4">
            <h2>四、数据存储与安全</h2>
            <p>
              我们采取合理的技术与管理措施保护你的信息安全。但互联网传输并非绝对安全，我们无法保证信息不被未经授权的访问、披露或篡改。你应在使用中注意保护账户凭证。
            </p>
          </section>

          <section id="section-5">
            <h2>五、数据保留</h2>
            <p>
              我们仅在实现本政策所述目的所必需的期限内保留你的信息，超出必要期限后将删除或匿名化处理，法律法规另有要求的除外。
            </p>
          </section>

          <section id="section-6">
            <h2>六、用户权利</h2>
            <p>
              在适用法律允许的范围内，你可就你的个人信息行使访问、更正、删除等权利。如需行使上述权利或有任何疑问，可通过本服务公布的官方渠道联系我们。
            </p>
          </section>

          <section id="section-7">
            <h2>七、Cookie 与同类技术</h2>
            <p>
              我们可能使用 Cookie 及同类技术维持登录状态、记录偏好与改进体验。你可通过浏览器设置管理 Cookie，但部分功能可能受影响。
            </p>
          </section>

          <section id="section-8">
            <h2>八、未成年人</h2>
            <p>
              本服务面向成年人。若你是未成年人，请在监护人陪同下阅读本政策并在取得同意后使用。我们不会故意收集未成年人个人信息。
            </p>
          </section>

          <section id="section-9">
            <h2>九、政策变更</h2>
            <p>
              我们可不时更新本隐私政策，更新后在页面公布并注明更新日期即生效。重大变更时我们将以适当方式提示你。
            </p>
          </section>

          <section id="section-10">
            <h2>十、联系我们</h2>
            <p>如对本政策或个人信息处理有任何问题，可通过本服务公布的官方渠道与我们联系。</p>
          </section>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button asChild variant="ghost" size="lg">
            <Link href={APP_ROUTES.terms}>阅读《用户协议》</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href="#main">
              回到顶部
              <ArrowUpIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </a>
          </Button>
        </div>
      </article>
    </PublicShell>
  )
}
