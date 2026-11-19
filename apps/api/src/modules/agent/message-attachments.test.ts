import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentCoreError } from '@musecanvas/database'
import { messageInput } from './validation'

/**
 * `POST /api/agent/sessions/:id/messages` — the attachment vocabulary.
 *
 * The only thing a client may name here is a managed id plus the identity it
 * believes that row carries. Shape is enforced at the edge; ownership, provenance
 * and liveness are proven against the database in `AgentCoreRepository.message`,
 * and again inside the paid transaction by `lockManagedGenerationInputs`. So these
 * cases are exactly the refusals that must happen before any query.
 */

const CLIENT_MESSAGE_ID = '10000000-0000-4000-8000-000000000001'
const SOURCE_ID = '20000000-0000-4000-8000-000000000001'
const MASK_ID = '30000000-0000-4000-8000-000000000001'
const SOURCE_CHECKSUM = 'a'.repeat(64)
const MASK_CHECKSUM = 'b'.repeat(64)

const source = {
  kind: 'asset',
  id: SOURCE_ID,
  role: 'reference_image',
  checksum: SOURCE_CHECKSUM,
  width: 1200,
  height: 800,
  mimeType: 'image/png',
}

const mask = {
  kind: 'upload',
  id: MASK_ID,
  role: 'mask',
  checksum: MASK_CHECKSUM,
  width: 1200,
  height: 800,
  mimeType: 'image/png',
  preparationVersion: 1,
  sourceChecksum: SOURCE_CHECKSUM,
}

const input = (attachments: unknown) => ({ clientMessageId: CLIENT_MESSAGE_ID, content: '把屋顶换成红色', attachments })

const refused = (attachments: unknown) =>
  assert.throws(() => messageInput(input(attachments)), (error: unknown) => error instanceof AgentCoreError && error.code === 'INVALID_INPUT')

test('a prepared mask and its source are accepted and canonicalised to one order', () => {
  const forward = messageInput(input([source, mask]))
  const reversed = messageInput(input([mask, source]))
  assert.deepEqual(forward.attachments, reversed.attachments)
  // The mask sorts first: (`role`, `kind`, `id`). The repository hashes this order,
  // so retrying the same pair in another order stays the same request.
  assert.deepEqual(forward.attachments?.map(attachment => attachment.role), ['mask', 'reference_image'])
  assert.deepEqual(forward.attachments?.[0], {
    kind: 'upload',
    id: MASK_ID,
    role: 'mask',
    checksum: MASK_CHECKSUM,
    width: 1200,
    height: 800,
    mimeType: 'image/png',
    preparationVersion: 1,
    sourceChecksum: SOURCE_CHECKSUM,
  })
})

test('checksums and ids are normalised to lower case, never trusted as typed', () => {
  const parsed = messageInput(input([{ ...source, id: SOURCE_ID.toUpperCase(), checksum: 'A'.repeat(64) }]))
  assert.equal(parsed.attachments?.[0]?.id, SOURCE_ID)
  assert.equal(parsed.attachments?.[0]?.checksum, 'a'.repeat(64))
})

test('no attachments stays an absent field so legacy digests are unchanged', () => {
  assert.deepEqual(messageInput({ clientMessageId: CLIENT_MESSAGE_ID, content: 'hi' }), { clientMessageId: CLIENT_MESSAGE_ID, content: 'hi' })
  assert.equal('attachments' in messageInput(input([])), false)
})

test('a mask is refused unless it is a prepared upload bound to a source checksum', () => {
  refused([{ ...mask, preparationVersion: 2 }])
  refused([{ ...mask, preparationVersion: undefined }])
  refused([{ ...mask, sourceChecksum: undefined }])
  refused([{ ...mask, sourceChecksum: 'not-a-checksum' }])
  // A plain PNG upload can never stand in for a trusted preparation identity.
  refused([{ ...mask, kind: 'asset' }])
})

test('a plain reference cannot smuggle mask provenance fields', () => {
  refused([{ ...source, preparationVersion: 1 }])
  refused([{ ...source, sourceChecksum: SOURCE_CHECKSUM }])
})

test('shape, size and duplicate refusals happen without a database', () => {
  refused([{ ...source, id: 'not-a-uuid' }])
  refused([{ ...source, role: 'mask' }])
  refused([{ ...source, kind: 'upload', mimeType: 'image/gif' }])
  refused([{ ...source, width: 0 }])
  refused([{ ...source, height: 1.5 }])
  refused([{ ...source, extra: 'nope' }])
  refused([source, source])
  refused(Array.from({ length: 5 }, (_, index) => ({ ...source, id: `20000000-0000-4000-8000-00000000000${index}` })))
  refused('not-an-array')
})
