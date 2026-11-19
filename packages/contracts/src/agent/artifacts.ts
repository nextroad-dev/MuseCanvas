interface AgentArtifactBaseDTO {
  sessionId: string
  turnId: string
  sourceItemId: string
  version: 1
  createdAt: string
}

/** Immutable v1 artifacts; ID suffixes are UUIDs identifying their source text or media. */
export type AgentArtifactDTO = AgentArtifactBaseDTO & (
  | { id: `text:${string}`; kind: 'text'; content: string }
  | {
    id: `media:${string}`
    kind: 'image' | 'video'
    assetId: string
    available: boolean
    width: number | null
    height: number | null
    durationMs: number | null
  }
)

/** Artifact and thread pages use independent opaque cursors. */
export interface AgentArtifactPageDTO { items: AgentArtifactDTO[]; nextCursor: string | null }
export interface AgentArtifactThreadsPageDTO { items: AgentArtifactThreadDTO[]; nextCursor: string | null }

export type AgentArtifactAnchor =
  | { kind: 'whole' }
  /** UTF-16 offsets: start inclusive, end exclusive; quote is the selected text. */
  | { kind: 'text'; start: number; end: number; quote: string }
  /** Image coordinates and dimensions are normalized to [0, 1]. */
  | { kind: 'image_point'; x: number; y: number }
  | { kind: 'image_rect'; x: number; y: number; width: number; height: number }
  | { kind: 'video'; timeMs: number }

/** Private annotations are separate from model context. */
export interface AgentArtifactThreadDTO {
  id: string
  artifactId: AgentArtifactDTO['id']
  version: 1
  anchor: AgentArtifactAnchor
  resolved: boolean
  resolvedAt: string | null
  messages: { id: string; body: string; createdAt: string }[]
  createdAt: string
}

export interface CreateAgentArtifactThreadRequest {
  clientRequestId: string
  version: 1
  anchor: AgentArtifactAnchor
  body: string
}
export interface CreateAgentArtifactReplyRequest { clientRequestId: string; body: string }
export interface ResolveAgentArtifactThreadRequest { resolved: boolean }
