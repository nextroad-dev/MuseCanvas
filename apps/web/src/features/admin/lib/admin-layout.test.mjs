import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { APP_ROUTES } from '../../../shared/lib/app-routes.ts'
import { loadTs } from '../../../shared/services/mock-workspace-test-loader.mjs'

const {
  ADMIN_NAV_GROUPS,
  adminBreadcrumb,
  adminNavItems,
  adminNavMatch,
  isAdminNavActive,
} = loadTs(new URL('./admin-layout.ts', import.meta.url), {
  '@/shared/lib/app-routes': { APP_ROUTES },
})

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_APP_DIR = path.resolve(HERE, '../../../app/admin')

function pageFileForAdminHref(href) {
  assert.ok(href === APP_ROUTES.admin || href.startsWith(`${APP_ROUTES.admin}/`), `非后台路由: ${href}`)
  const subPath = href.slice(APP_ROUTES.admin.length).replace(/^\/+/, '')
  return subPath ? path.join(ADMIN_APP_DIR, subPath, 'page.tsx') : path.join(ADMIN_APP_DIR, 'page.tsx')
}

function collectAdminPageRoutes(dir, prefix = APP_ROUTES.admin) {
  const routes = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue
      routes.push(...collectAdminPageRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`))
    } else if (entry.isFile() && entry.name === 'page.tsx') {
      routes.push(prefix)
    }
  }
  return routes
}

test('ADMIN_NAV_GROUPS 的每个 href 都对应真实的 app/admin/**/page.tsx 且覆盖全部 4 个路由', () => {
  const items = adminNavItems()
  const hrefs = items.map((item) => item.href)

  assert.deepEqual(hrefs, [
    APP_ROUTES.admin,
    APP_ROUTES.adminPromptTemplates,
    APP_ROUTES.adminOAuth,
    APP_ROUTES.adminSettings,
  ])

  for (const group of ADMIN_NAV_GROUPS) {
    assert.ok(group.items.length > 0, '分组不应为空')
    for (const item of group.items) {
      assert.ok(item.label.length > 0)
      assert.equal(
        existsSync(pageFileForAdminHref(item.href)),
        true,
        `导航项 ${item.label} (${item.href}) 缺少对应的 page.tsx`,
      )
    }
  }

  const diskRoutes = collectAdminPageRoutes(ADMIN_APP_DIR).sort()
  assert.deepEqual([...hrefs].sort(), diskRoutes)

  for (const removed of ['/admin/users', '/admin/media-models', '/admin/language-models', '/admin/jobs']) {
    assert.equal(hrefs.includes(removed), false, `已移除路由不应出现在导航中: ${removed}`)
  }
})

test('isAdminNavActive 对 4 个有效路由及边界路径判定准确', () => {
  const validRoutes = [
    APP_ROUTES.admin,
    APP_ROUTES.adminPromptTemplates,
    APP_ROUTES.adminOAuth,
    APP_ROUTES.adminSettings,
  ]

  for (const route of validRoutes) {
    assert.equal(isAdminNavActive(route, route), true)
    assert.equal(isAdminNavActive(`${route}/`, route), true)
    assert.equal(isAdminNavActive(`${route}?tab=1`, route), true)
    assert.equal(isAdminNavActive(null, route), false)
    assert.equal(isAdminNavActive(undefined, route), false)
  }

  // /admin 必须精确匹配，不能高亮子路由
  assert.equal(isAdminNavActive(APP_ROUTES.adminPromptTemplates, APP_ROUTES.admin), false)
  assert.equal(isAdminNavActive(APP_ROUTES.adminOAuth, APP_ROUTES.admin), false)
  assert.equal(isAdminNavActive(APP_ROUTES.adminSettings, APP_ROUTES.admin), false)

  // 非概览路由允许嵌套子路径高亮，但不误命中同前缀兄弟路径
  assert.equal(isAdminNavActive(`${APP_ROUTES.adminPromptTemplates}/v2`, APP_ROUTES.adminPromptTemplates), true)
  assert.equal(isAdminNavActive(`${APP_ROUTES.adminOAuth}/github`, APP_ROUTES.adminOAuth), true)
  assert.equal(isAdminNavActive(`${APP_ROUTES.adminSettings}/storage`, APP_ROUTES.adminSettings), true)
  assert.equal(isAdminNavActive('/admin/oauth-extra', APP_ROUTES.adminOAuth), false)
  assert.equal(isAdminNavActive('/admin/settings-extra', APP_ROUTES.adminSettings), false)
})

test('adminBreadcrumb 与 adminNavMatch 正确映射 4 个有效路由并对无效路径返回 null', () => {
  assert.deepEqual(adminBreadcrumb(APP_ROUTES.admin), {
    label: '概览',
    group: null,
    href: APP_ROUTES.admin,
  })
  assert.deepEqual(adminBreadcrumb(APP_ROUTES.adminPromptTemplates), {
    label: '提示词模板',
    group: '生成资源',
    href: APP_ROUTES.adminPromptTemplates,
  })
  assert.deepEqual(adminBreadcrumb(APP_ROUTES.adminOAuth), {
    label: 'OAuth',
    group: '系统设置',
    href: APP_ROUTES.adminOAuth,
  })
  assert.deepEqual(adminBreadcrumb(APP_ROUTES.adminSettings), {
    label: '系统配置',
    group: '系统设置',
    href: APP_ROUTES.adminSettings,
  })
  assert.deepEqual(adminBreadcrumb(`${APP_ROUTES.adminSettings}/runtime?section=1`), {
    label: '系统配置',
    group: '系统设置',
    href: APP_ROUTES.adminSettings,
  })

  const match = adminNavMatch(APP_ROUTES.adminOAuth)
  assert.equal(match?.group.title, '系统设置')
  assert.equal(match?.item.icon, 'oauth')

  for (const invalid of [
    null,
    undefined,
    '',
    '/admin/users',
    '/admin/media-models',
    '/admin/language-models',
    '/admin/jobs',
    '/admin/unknown',
  ]) {
    assert.equal(adminBreadcrumb(invalid), null)
    assert.equal(adminNavMatch(invalid), null)
  }
})
