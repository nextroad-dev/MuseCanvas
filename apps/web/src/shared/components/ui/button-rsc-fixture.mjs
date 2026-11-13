import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToReadableStream, registerClientReference } from 'next/dist/compiled/react-server-dom-webpack/server.edge.js'
import { loadButtonModules } from './button-rsc-test-helper.mjs'

const Link = registerClientReference(() => {}, 'test-link', 'default')
const Interaction = registerClientReference(() => {}, 'test-button-interaction', 'ButtonInteraction')
const { Button } = loadButtonModules(React, Interaction)
const manifest = {
  'test-link': { id: 'test-link', chunks: [], name: 'default', async: false },
  'test-button-interaction': { id: 'test-button-interaction', chunks: [], name: 'ButtonInteraction', async: false },
}
const errors = []
const stream = await renderToReadableStream(React.createElement('main', null,
  React.createElement(Button, { asChild: true }, React.createElement(Link, { href: '/' }, '回到首页')),
  React.createElement(Button, { variant: 'secondary', asChild: true }, React.createElement(Link, { href: '/generate' }, '进入创作台')),
  React.createElement(Button, null, 'Static native button'),
  React.createElement(Button, { loading: true }, 'Loading native button'),
  React.createElement(Button, { asChild: true, disabled: true }, React.createElement(Link, { href: '/' }, 'Disabled link')),
), manifest, { onError: (error) => { errors.push(error.message) } })
const payload = await new Response(stream).text()
assert.deepEqual(errors, [], `Flight serialization errors: ${errors.join('; ')}`)
assert.ok(payload.includes('test-link'))
assert.ok(payload.includes('test-button-interaction'))
console.log('Static links/native buttons and guarded controls serialize successfully through React Flight.')
