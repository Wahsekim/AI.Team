// The dashboard snapshot: the only contract between collect.mjs (reads the
// instance) and render.mjs (writes HTML). Every value a reader could mistake
// for data is a Field, so "no source" is a state the renderer must show and
// can never be a sample value or a zero.
//
// Field<T> = { state, value: T | null, source: string | null, reason: string | null }
//   available       read as is from a record (source names the file and key)
//   derived         computed from records (source names the method)
//   counting        the record that settles it is not written yet
//   stale           sampled too long ago (quota only)
//   not-applicable  the field has no meaning here (e.g. a model for a kit step)
//   unavailable     no source exists today; reason says why
//
// Snapshot {
//   schemaVersion: 1, collectedAt: ISO, timezone: IANA name
//   project:  { name: Field<string>, slug: Field<string>, mode: Field<'router-worker'|'specialist'> }
//   quota:    Field<{ accountId, sampledAt, windows: [{ key: '5h'|'7d', usedPercentage, resetsAt }] }>
//   milestone: Field<never>
//   instanceTokens: Field<number>        settled input+cache_creation over every batch, one per runId
//   batch:    Field<Batch>
//   sources:  [{ name, path, found }]     completeness, instance-relative paths
// }
// Batch {
//   runId, phase: 'open'|'returned'|'closed'|'archived', branch: Field<string>
//   openedAt, closedAt, archivedAt: Field<ISO>
//   roundCurrent, roundCeiling, ticketTotal, acceptedCount: Field<number>
//   tokens: Field<number> (input+cache_creation, settled); outputTokens: Field<number> (engine meter)
//   unattributed: { guardian, mainSession, reviews: Field<number> }
//   runElapsedMs, waitingMs: Field<number>
//   halt: Field<{ reason, requiresAck }>; blockers: Field<string[]>; next: string[]
//   guardian: Field<{ verdict, findings: string[] }>
//   activeTicketId: string | null, activeKind: 'running'|'last-executed'|null
//   tickets: Ticket[], artifacts: Artifact[]
// }
// Ticket {
//   id, title, goal: Field<string>, acceptance: string[]
//   status: TicketStatus, pmPending: boolean, archivedWithoutCommit: boolean
//   attempt, attemptCeiling: Field<number>
//   tokens, authorizedTokens, outputTokens: Field<number>
//   rework: 'none'|'suggested'|'redispatched'
//   nodes: [Node exec, Node check, Node commit], focusNode: 0|1|2
// }
// Node {
//   key: 'exec'|'check'|'commit', state: NodeState
//   wrapper, model: Field<string>, attempt: Field<number>
//   activity, detail: Field<string>, failures: string[], files: Field<string[]>
//   event: { text, at: Field<ISO>, atKind: 'first-tool-call'|'record' }, elapsedMs: Field<number>
//   tokens, outputTokens: Field<number>, split: Field<{ input, output, cacheCreate, cacheRead, model }>
//   artifacts: Artifact[]
// }
// Artifact { name, path (instance-relative), href (file URL) | null, version: string | null, available }

export const FIELD_STATES = ['available', 'derived', 'counting', 'stale', 'not-applicable', 'unavailable']

export const TICKET_STATUSES = ['committed', 'accepted', 'checking', 'running', 'failed', 'blocked', 'queued', 'unrecorded']

// tone drives colour; the label always carries the state in text as well.
export const NODE_STATES = {
  done: { tone: 'green', symbol: '✓' },
  running: { tone: 'blue', symbol: null },
  failed: { tone: 'red', symbol: '×' },
  blocked: { tone: 'red', symbol: '×' },
  stopped: { tone: 'grey', symbol: null },
  archived: { tone: 'grey', symbol: null },
  waiting: { tone: 'grey', symbol: null },
  pending: { tone: 'grey', symbol: null },
}

const make = (state, value, source, reason) => ({ state, value, source, reason })

export const available = (value, source) => make('available', value, source, null)
export const derived = (value, source) => make('derived', value, source, null)
export const counting = (source, reason) => make('counting', null, source, reason)
export const stale = (value, source, reason) => make('stale', value, source, reason)
export const notApplicable = reason => make('not-applicable', null, null, reason)
export const unavailable = (reason, source = null) => make('unavailable', null, source, reason)

export const hasValue = field => field.value !== null && field.value !== undefined
