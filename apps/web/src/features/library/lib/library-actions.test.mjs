import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./library-actions.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const actions = {}
runInThisContext(`(function(exports) { ${outputText}\n})`)(actions)

test('reuse chooses original user input and never exposes the final prompt', () => {
  assert.equal(actions.reusablePrompt({ inputPrompt: '  original  ', prompt: 'rendered', finalPrompt: 'private' }), 'original')
  assert.equal(actions.reusablePrompt({ inputPrompt: ' ', prompt: 'fallback' }), 'fallback')
})

test('generation query round-trips reserved characters and carries media kind', () => {
  const prompt = '水彩 & 光影? #1 / + = 🌿'
  const query = new URLSearchParams(actions.generationSearch({ prompt, mediaKind: 'video' }))
  assert.equal(query.get('prompt'), prompt)
  assert.equal(query.get('kind'), 'video')
  assert.deepEqual([...query.keys()], ['prompt', 'kind'])
})

test('selection is scoped to the visible loaded assets and deduplicated', () => {
  assert.deepEqual(actions.visibleSelection(['gone', 'b', 'a', 'b'], [{ id: 'a' }, { id: 'b' }]), ['b', 'a'])
  assert.deepEqual(actions.visibleSelection(['a'], []), [])
})

test('download supports local fixtures, signed HTTPS URLs and browser blobs', () => {
  assert.equal(actions.downloadableUrl('/showcase/art.svg', 'http://localhost:3000'), 'http://localhost:3000/showcase/art.svg')
  assert.equal(actions.downloadableUrl('https://storage.test/a?signature=123', 'http://localhost'), 'https://storage.test/a?signature=123')
  assert.equal(actions.downloadableUrl('blob:http://localhost/a', 'http://localhost'), 'blob:http://localhost/a')
})

test('download rejects executable and inline URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///secrets']) {
    assert.throws(() => actions.downloadableUrl(url, 'https://example.test'), /下载地址无效/)
  }
})

test('video grid never renders an image using the video file or invents a poster', () => {
  const asset = { mediaKind: 'video', url: '/movie.mp4', imageUrl: '/movie.mp4' }
  assert.equal(actions.previewSource(asset), '')
  assert.equal(actions.previewSource({ ...asset, posterUrl: '/poster.jpg' }), '/poster.jpg')
  assert.equal(actions.previewSource({ ...asset, posterUrl: '/poster.jpg', thumbnailUrl: '/small.jpg' }), '/small.jpg')
  assert.equal(actions.previewSource({ mediaKind: 'image', url: '/original.png', thumbnailUrl: '/thumb.webp' }), '/thumb.webp')
})
