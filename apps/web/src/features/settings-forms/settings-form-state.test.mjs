import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isAbsoluteLocalPath,
  isPlausibleEmail,
  keepIfEmpty,
  keepIfEmptyNumber,
  resolveRuntimeValues,
  runtimeDraftChanged,
  runtimeDraftFromValues,
  runtimeTotalBelowImage,
  siteDraftChanged,
  siteDraftFromDto,
  smtpDraftChanged,
  smtpDraftFromDto,
  storageDraftChanged,
  storageDraftFromDto,
  toSiteInput,
  toSmtpInput,
  toStorageInput,
  validateRuntimeDraft,
  validateSiteDraft,
  validateSmtpDraft,
  validateStorageDraft,
} from './settings-form-state.ts'

const smtpDto = {
  host: 'smtp.example.com',
  port: 465,
  tlsMode: 'implicit_tls',
  username: 'mailer',
  fromAddress: 'noreply@example.com',
  fromName: 'MuseCanvas',
  hasSecret: true,
  secretFingerprint: 'fp',
  encryptionKeyId: 'k1',
  status: 'verified',
  revision: 4,
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const storageDto = {
  driver: 's3',
  localRoot: null,
  endpoint: 'https://minio.internal:9000',
  publicEndpoint: null,
  region: 'us-east-1',
  bucket: 'assets',
  accessKeyId: 'AKIA',
  signedUrlTtlSeconds: 900,
  hasSecret: true,
  secretFingerprint: 'fp',
  encryptionKeyId: 'k1',
  status: 'verified',
  revision: 2,
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const runtimeValues = {
  uploadTtlSeconds: 86400,
  signedUrlTtlSeconds: 900,
  maxImageBytes: 10_000_000,
  maxTotalBytes: 20_000_000,
  maxInputs: 4,
  providerTimeoutMs: 300_000,
  maxOutputBytes: 100_000_000,
  jobLeaseMs: 600_000,
}

test('keep-if-empty helpers omit blank input so the server keeps the stored value', () => {
  assert.equal(keepIfEmpty('   '), undefined)
  assert.equal(keepIfEmpty('  smtp.example.com '), 'smtp.example.com')
  assert.equal(keepIfEmptyNumber(''), undefined)
  assert.equal(keepIfEmptyNumber(' 587 '), 587)
})

test('untouched SMTP password is never part of the payload; a typed one is', () => {
  const draft = smtpDraftFromDto(smtpDto)
  assert.equal(draft.password, '', 'drafts start with an empty write-only secret')
  const untouched = JSON.parse(JSON.stringify(toSmtpInput(draft, smtpDto)))
  assert.equal('password' in untouched, false)
  assert.equal(smtpDraftChanged(draft, smtpDto), false, 'an untouched form is a no-op save')

  const typed = { ...draft, password: '  new-secret  ' }
  assert.equal(toSmtpInput(typed, smtpDto).password, 'new-secret')
  assert.equal(smtpDraftChanged(typed, smtpDto), true)
})

test('SMTP payload sends tlsMode only when it differs from the stored value', () => {
  const draft = smtpDraftFromDto(smtpDto)
  assert.equal(toSmtpInput(draft, smtpDto).tlsMode, undefined)
  assert.equal(toSmtpInput({ ...draft, tlsMode: 'starttls' }, smtpDto).tlsMode, 'starttls')
})

test('blank SMTP host and port keep stored values; the port is numeric when provided', () => {
  const draft = { ...smtpDraftFromDto(smtpDto), host: '  ', port: '' }
  const input = toSmtpInput(draft, smtpDto)
  assert.equal(input.host, undefined)
  assert.equal(input.port, undefined)
  assert.equal(toSmtpInput({ ...draft, port: '2525' }, smtpDto).port, 2525)
})

test('site payload trims and clears an empty URL to null, mirroring the stored shape', () => {
  const dto = { siteName: 'Muse', siteUrl: 'https://muse.example.com' }
  const draft = siteDraftFromDto(dto)
  assert.equal(siteDraftChanged(draft, dto), false)
  assert.deepEqual(toSiteInput({ siteName: '  Muse Two ', siteUrl: '   ' }), { siteName: 'Muse Two', siteUrl: null })
  assert.equal(siteDraftChanged({ siteName: 'Muse', siteUrl: '' }, dto), true, 'clearing the stored URL is a change')
})

test('storage driver is sent only when switched; an untouched S3 draft carries no driver or local root', () => {
  const draft = storageDraftFromDto(storageDto)
  assert.equal(draft.driver, 's3')
  const untouched = JSON.parse(JSON.stringify(toStorageInput(draft, storageDto)))
  assert.equal('driver' in untouched, false)
  assert.equal('localRoot' in untouched, false)
  assert.equal('secretAccessKey' in untouched, false, 'untouched write-only secret is omitted')
  assert.equal(storageDraftChanged(draft, storageDto), false)
})

test('switching to the local driver sends the driver and the trimmed absolute root', () => {
  const draft = { ...storageDraftFromDto(storageDto), driver: 'local', localRoot: ' /data/musecanvas/assets ' }
  const input = toStorageInput(draft, storageDto)
  assert.equal(input.driver, 'local')
  assert.equal(input.localRoot, '/data/musecanvas/assets')
  assert.equal(storageDraftChanged(draft, storageDto), true)
})

test('storage secret is write-only: a typed value is trimmed and never echoed back into the draft', () => {
  const draft = { ...storageDraftFromDto(storageDto), secretAccessKey: ' s3cr3t ' }
  assert.equal(toStorageInput(draft, storageDto).secretAccessKey, 's3cr3t')
  assert.equal(storageDraftFromDto({ ...storageDto, hasSecret: true }).secretAccessKey, '')
})

test('absolute local path accepts POSIX, drive-letter and UNC forms and rejects relative paths', () => {
  for (const ok of ['/data/musecanvas', 'D:\\musecanvas\\assets', 'd:/assets', '\\\\nas\\share\\assets']) {
    assert.equal(isAbsoluteLocalPath(ok), true, ok)
  }
  for (const bad of ['', 'data/assets', './assets', 'D:assets']) {
    assert.equal(isAbsoluteLocalPath(bad), false, bad)
  }
})

test('runtime draft falls back to stored values for blank inputs and reports real changes', () => {
  const draft = runtimeDraftFromValues(runtimeValues)
  assert.deepEqual(resolveRuntimeValues(draft, runtimeValues), runtimeValues)
  assert.equal(runtimeDraftChanged(draft, runtimeValues), false)
  const blank = { ...draft, maxInputs: '' }
  assert.equal(resolveRuntimeValues(blank, runtimeValues).maxInputs, runtimeValues.maxInputs)
  assert.equal(runtimeDraftChanged(blank, runtimeValues), false)
  assert.equal(runtimeDraftChanged({ ...draft, maxInputs: '8' }, runtimeValues), true)
})

test('runtime total cap below the single-image cap is flagged on the total field', () => {
  assert.equal(runtimeTotalBelowImage({ maxTotalBytes: 5, maxImageBytes: 10 }), true)
  assert.equal(runtimeTotalBelowImage({ maxTotalBytes: 10, maxImageBytes: 10 }), false)
  const draft = { ...runtimeDraftFromValues(runtimeValues), maxTotalBytes: '1000' }
  assert.equal(validateRuntimeDraft(draft, runtimeValues).maxTotalBytes, '总大小上限不能小于单图大小上限。')
})

test('runtime validation enforces integers inside each field range and skips blank fields', () => {
  const draft = runtimeDraftFromValues(runtimeValues)
  assert.deepEqual(validateRuntimeDraft(draft, runtimeValues), {})
  assert.ok(validateRuntimeDraft({ ...draft, maxInputs: '33' }, runtimeValues).maxInputs)
  assert.ok(validateRuntimeDraft({ ...draft, signedUrlTtlSeconds: '59' }, runtimeValues).signedUrlTtlSeconds)
  assert.ok(validateRuntimeDraft({ ...draft, jobLeaseMs: '1.5' }, runtimeValues).jobLeaseMs)
  assert.deepEqual(validateRuntimeDraft({ ...draft, jobLeaseMs: '' }, runtimeValues), {})
})

test('site validation requires a name and accepts only HTTPS root origins (plain HTTP only for localhost)', () => {
  const base = { siteName: 'Muse', siteUrl: '' }
  assert.deepEqual(validateSiteDraft(base), {})
  assert.ok(validateSiteDraft({ ...base, siteName: '   ' }).siteName)
  assert.ok(validateSiteDraft({ ...base, siteName: 'x'.repeat(121) }).siteName)
  assert.deepEqual(validateSiteDraft({ ...base, siteUrl: 'https://muse.example.com' }), {})
  assert.deepEqual(validateSiteDraft({ ...base, siteUrl: 'http://localhost:3000' }), {})
  assert.ok(validateSiteDraft({ ...base, siteUrl: 'http://muse.example.com' }).siteUrl)
  assert.ok(validateSiteDraft({ ...base, siteUrl: 'https://muse.example.com/app' }).siteUrl)
  assert.ok(validateSiteDraft({ ...base, siteUrl: 'https://muse.example.com?x=1' }).siteUrl)
  assert.ok(validateSiteDraft({ ...base, siteUrl: 'not a url' }).siteUrl)
})

test('SMTP validation requires a host only when none is stored, checks port and sender address', () => {
  const empty = { ...smtpDraftFromDto({ ...smtpDto, host: null }), host: '' }
  assert.ok(validateSmtpDraft(empty, { host: null }).host)
  assert.equal(validateSmtpDraft({ ...empty, host: '' }, { host: 'smtp.example.com' }).host, undefined)
  assert.ok(validateSmtpDraft({ ...empty, port: '70000' }, { host: 'h' }).port)
  assert.ok(validateSmtpDraft({ ...empty, fromAddress: 'not-an-email' }, { host: 'h' }).fromAddress)
  assert.deepEqual(validateSmtpDraft({ ...empty, fromAddress: 'ops@example.com' }, { host: 'h' }), {})
})

test('storage validation checks the driver-specific fields only', () => {
  const s3 = storageDraftFromDto(storageDto)
  assert.deepEqual(validateStorageDraft(s3, storageDto), {})
  assert.ok(validateStorageDraft({ ...s3, bucket: '' }, { localRoot: null, bucket: null }).bucket)
  assert.equal(validateStorageDraft({ ...s3, bucket: '' }, storageDto).bucket, undefined, 'stored bucket is kept')
  assert.ok(validateStorageDraft({ ...s3, endpoint: 'ftp://x' }, storageDto).endpoint)
  assert.ok(validateStorageDraft({ ...s3, signedUrlTtlSeconds: '4000' }, storageDto).signedUrlTtlSeconds)

  const local = { ...s3, driver: 'local', localRoot: 'relative/dir' }
  assert.ok(validateStorageDraft(local, { localRoot: null, bucket: null }).localRoot)
  assert.deepEqual(validateStorageDraft({ ...local, localRoot: '/srv/assets' }, storageDto), {}, 'S3 fields are not checked for local')
  assert.ok(validateStorageDraft({ ...local, localRoot: '' }, { localRoot: null, bucket: null }).localRoot)
})

test('email plausibility is a client-side shape check only', () => {
  assert.equal(isPlausibleEmail(' admin@example.com '), true)
  assert.equal(isPlausibleEmail('admin@localhost'), false)
  assert.equal(isPlausibleEmail('admin example.com'), false)
})
