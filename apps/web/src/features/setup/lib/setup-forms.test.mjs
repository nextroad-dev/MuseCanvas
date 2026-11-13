import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectionStatusLabel,
  isPlausibleEmail,
  maskConnectionValue,
  parseTemplateImportText,
  runtimeDraftFromDto,
  siteDraftFromDto,
  smtpDraftFromDto,
  storageDraftFromDto,
  toRuntimeInput,
  toSiteInput,
  toSmtpInput,
  toStorageInput,
  validatePublicOrigin,
  validateRuntimeDraft,
  validateSiteDraft,
  validateSmtpDraft,
  validateStorageDraft,
} from './setup-forms.ts'

const siteDto = { siteName: 'MuseCanvas', siteUrl: 'https://canvas.example.com', revision: 1, updatedAt: '' }
const smtpDto = {
  host: 'smtp.example.com', port: 587, tlsMode: 'starttls', username: 'bot',
  fromAddress: 'bot@example.com', fromName: 'MuseCanvas', hasSecret: true,
  secretFingerprint: 'fp', encryptionKeyId: 'k1', status: 'verified', revision: 1, updatedAt: '',
}
const storageDto = {
  driver: 's3', localRoot: null, endpoint: 'https://s3.example.com', publicEndpoint: null,
  region: 'us-east-1', bucket: 'muse', accessKeyId: 'AKIA', signedUrlTtlSeconds: 900,
  hasSecret: true, secretFingerprint: 'fp', encryptionKeyId: 'k1', status: 'verified', revision: 1, updatedAt: '',
}
const runtimeDto = {
  uploadTtlSeconds: 86400, signedUrlTtlSeconds: 900, maxImageBytes: 10_000_000,
  maxTotalBytes: 20_000_000, maxInputs: 4, providerTimeoutMs: 300_000,
  maxOutputBytes: 100_000_000, jobLeaseMs: 600_000, revision: 0, updatedAt: '',
}

test('站点：名称必填、地址必须是 origin 且 HTTPS（localhost 例外）', () => {
  assert.equal(isPlausibleEmail('forrest@example.com'), true)
  assert.equal(isPlausibleEmail('forrest@example'), false)

  const draft = siteDraftFromDto(siteDto)
  assert.equal(draft.siteName, 'MuseCanvas')
  assert.match(validateSiteDraft({ siteName: '', siteUrl: '' }).siteName ?? '', /站点名称/)
  assert.equal(validateSiteDraft({ siteName: 'X', siteUrl: '' }).siteUrl, undefined)
  assert.equal(validatePublicOrigin('http://localhost:3000'), null)
  assert.match(validatePublicOrigin('http://canvas.example.com') ?? '', /HTTPS/)
  assert.match(validatePublicOrigin('https://example.com/path') ?? '', /不能包含路径/)
  assert.match(validatePublicOrigin('https://example.com/?q=1') ?? '', /查询参数/)
  assert.match(validatePublicOrigin('not a url') ?? '', /合法的 URL/)
  assert.deepEqual(toSiteInput({ siteName: '  X  ', siteUrl: 'https://x.example.com//' }), {
    siteName: 'X', siteUrl: 'https://x.example.com',
  })
})

test('SMTP：端口校验、密码留空保持、勾选清除才发送 null', () => {
  const draft = smtpDraftFromDto(smtpDto)
  assert.equal(draft.password, '')
  assert.equal(draft.clearPassword, false)
  assert.equal(Object.keys(validateSmtpDraft(draft)).length, 0)
  assert.match(validateSmtpDraft({ ...draft, host: '' }).host ?? '', /服务器地址/)
  assert.match(validateSmtpDraft({ ...draft, port: '70000' }).port ?? '', /1–65535/)
  assert.match(validateSmtpDraft({ ...draft, fromAddress: 'nope' }).fromAddress ?? '', /发件人邮箱/)
  assert.match(validateSmtpDraft({ ...draft, password: 'x', clearPassword: true }).password ?? '', /清除密码/)

  const keep = toSmtpInput({ ...draft, password: '' })
  assert.equal('password' in keep, false)
  assert.equal(keep.host, 'smtp.example.com')
  assert.equal(keep.port, 587)
  assert.equal(toSmtpInput({ ...draft, password: 'secret' }).password, 'secret')
  assert.equal(toSmtpInput({ ...draft, clearPassword: true }).password, null)
})

test('对象存储：local 只发目录，s3 必填项完整且密钥留空时沿用已存密钥', () => {
  const draft = storageDraftFromDto(storageDto)
  assert.equal(Object.keys(validateStorageDraft(draft, { hasStoredSecret: true })).length, 0)
  assert.match(validateStorageDraft({ ...draft, bucket: '' }, { hasStoredSecret: true }).bucket ?? '', /桶名/)
  assert.match(
    validateStorageDraft({ ...draft, secretAccessKey: '' }, { hasStoredSecret: false }).secretAccessKey ?? '',
    /访问密钥/,
  )

  const keep = toStorageInput({ ...draft, secretAccessKey: '' }, { hasStoredSecret: true })
  assert.equal('secretAccessKey' in keep, false)
  assert.equal(keep.driver, 's3')
  assert.equal(keep.bucket, 'muse')

  const local = { ...draft, driver: 'local', localRoot: '/data/storage' }
  assert.equal(validateStorageDraft(local, { hasStoredSecret: true }).localRoot, undefined)
  assert.match(
    validateStorageDraft({ ...local, localRoot: 'data/storage' }, { hasStoredSecret: true }).localRoot ?? '',
    /绝对路径/,
  )
  assert.match(
    validateStorageDraft({ ...local, localRoot: '/data/../etc' }, { hasStoredSecret: true }).localRoot ?? '',
    /绝对路径/,
  )
  const localInput = toStorageInput(local, { hasStoredSecret: true })
  assert.equal(localInput.localRoot, '/data/storage')
  assert.equal('bucket' in localInput, false)
  assert.equal(connectionStatusLabel('verified'), '已验证')
  assert.equal(maskConnectionValue('postgres'), 'po•••es')
  assert.equal(maskConnectionValue(null), '未提供')
})

test('运行时限制：范围校验、跨字段约束与请求体', () => {
  const draft = runtimeDraftFromDto(runtimeDto)
  assert.equal(Object.keys(validateRuntimeDraft(draft)).length, 0)
  assert.match(validateRuntimeDraft({ ...draft, uploadTtlSeconds: '10' }).uploadTtlSeconds ?? '', /300/)
  assert.match(validateRuntimeDraft({ ...draft, maxInputs: '1.5' }).maxInputs ?? '', /整数/)
  assert.match(
    validateRuntimeDraft({ ...draft, maxImageBytes: '30000000', maxTotalBytes: '20000000' }).maxTotalBytes ?? '',
    /不能小于/,
  )
  const input = toRuntimeInput(draft)
  assert.equal(input.uploadTtlSeconds, 86400)
  assert.equal(input.maxTotalBytes, 20_000_000)
})

test('模板导入 JSON：裸数组与对象均可，名称/内容必填且不重复', () => {
  const bare = parseTemplateImportText(
    JSON.stringify([{ name: 'A', instruction: '画 {{input_prompt}}' }, { name: 'B', content: 'x', description: 'd' }]),
  )
  assert.equal(bare.ok, true)
  if (bare.ok) {
    assert.deepEqual(bare.entries, [
      { name: 'A', instruction: '画 {{input_prompt}}' },
      { name: 'B', description: 'd', instruction: 'x' },
    ])
  }

  const wrapped = parseTemplateImportText(JSON.stringify({ templates: [{ name: 'A', instruction: 'x' }] }))
  assert.equal(wrapped.ok, true)
  assert.equal(parseTemplateImportText('').ok, false)
  assert.equal(parseTemplateImportText('{').ok, false)
  assert.equal(parseTemplateImportText('{"templates":[]}').ok, false)
  assert.equal(parseTemplateImportText(JSON.stringify([{ instruction: 'x' }])).ok, false)
  assert.equal(parseTemplateImportText(JSON.stringify([{ name: 'A', instruction: ' ' }])).ok, false)
  assert.equal(
    parseTemplateImportText(JSON.stringify([{ name: 'A', instruction: 'x' }, { name: 'A', instruction: 'y' }])).ok,
    false,
  )
  assert.equal(parseTemplateImportText(JSON.stringify({ nope: [] })).ok, false)
})
