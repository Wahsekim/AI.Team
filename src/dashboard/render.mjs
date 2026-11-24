// Snapshot (model.mjs) -> one self-contained HTML page. Every instance string
// goes through esc(); the page loads nothing from the network.
import { readFileSync } from 'node:fs'
import { NODE_STATES } from './model.mjs'
import { STRINGS as S } from './strings.mjs'
import { icon } from './icons.mjs'

const CSS = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
const CLIENT = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"
const MAX_DOTS = 12

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = value => String(value).replace(/[&<>"']/g, c => ENTITIES[c])

const int = n => new Intl.NumberFormat('en-US').format(n)

function duration(ms) {
  const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  if (h) return `${h} h ${m} min`
  return m ? `${m} min ${s} s` : `${s} s`
}

const timeFormat = (tz, withDate) => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  ...(withDate ? { day: 'numeric', month: 'short' } : {}),
})

// One rendering per Field state, so "no source" can never look like a value.
function field(f, fmt = String, { reason = false } = {}) {
  const why = f.reason ? esc(f.reason) : ''
  const tail = reason && why ? ` <span class="na-reason">${why}</span>` : ''
  let body
  if (f.state === 'available' || f.state === 'derived') {
    body = esc(fmt(f.value)) + (f.source?.includes('approx') ? ' <span class="muted">(approx.)</span>' : '')
  } else if (f.state === 'stale') {
    body = `${esc(fmt(f.value))} <span class="na">· ${S.stale}</span>${tail}`
  } else {
    const label = { counting: S.counting, 'not-applicable': S.notApplicable }[f.state] ?? S.unavailable
    body = `<span class="na" title="${why}">${label}</span>${tail}`
  }
  return `<span class="field" data-state="${f.state}">${body}</span>`
}

function appbar(snap) {
  const { name, mode } = snap.project
  return `<header class="appbar"><div class="flex"><span class="brandmark">${icon('network')}</span><span class="brand">AI.Team</span><span class="crumb">${S.crumb}</span></div>
<div class="flex project-id"><strong>${field(name)}</strong><span class="muted">${field(mode)}</span></div></header>`
}

function quotaBar(snap, t) {
  const q = snap.quota
  const head = `<span class="quota-label flex">${icon('gauge')}<strong>${S.quotaTitle}</strong><span class="muted">${S.quotaScope}</span></span>`
  let items
  if (q.value) {
    items = q.value.windows.map(w => `<div class="quota-item"><span class="muted">${esc(w.key)}</span><div class="micro-track" role="img" aria-label="${esc(w.key)} window ${esc(w.usedPercentage)}% used of 100%"><span class="micro-fill" style="width:${Number(w.usedPercentage)}%"></span></div><strong class="num">${esc(w.usedPercentage)}%</strong><span class="muted reset">${w.resetsAt ? `resets ${esc(t.date.format(new Date(w.resetsAt)))}` : 'reset time unknown'}</span></div>`).join('')
      + `<span class="muted">sampled ${esc(t.clock.format(new Date(q.value.sampledAt)))}${q.state === 'stale' ? ` · <span class="na">${S.stale}</span>` : ''}</span>`
  } else {
    items = `<span class="quota-item">${field(q, String, { reason: true })}</span>`
  }
  return `<div class="quota" aria-label="Account-wide subscription quota" data-quota-state="${q.state}">${head}${items}<span class="quota-note">${S.quotaNote}</span></div>`
}

function projectLine(snap) {
  const batch = snap.batch.value
  const blockers = batch ? batch.blockers : snap.batch
  return `<div class="projectline"><div><h2>${field(snap.project.name)}</h2><div class="milestone">${S.milestone}: ${field(snap.milestone, String, { reason: true })}</div></div>
<div class="project-stats"><span>${S.batchTokens}<strong class="num">${field(batch ? batch.tokens : snap.batch, int)}</strong></span><span>${S.batchBlockers}<strong class="num">${field(blockers, v => v.length)}</strong></span><span>${S.instanceTokens}<strong class="num">${field(snap.instanceTokens, int)}</strong></span></div></div>`
}

function roundDots(batch) {
  const cur = batch.roundCurrent.value, max = batch.roundCeiling.value
  if (!Number.isInteger(cur) || !Number.isInteger(max)) return ''
  if (max > MAX_DOTS) return `<div class="dots small muted">${int(cur)} of ${int(max)} rounds run</div>`
  const dots = Array.from({ length: max }, (_, i) => `<span class="dot ${i < cur - 1 ? 'done' : i === cur - 1 ? 'now' : ''}"></span>`).join('')
  return `<div class="dots" role="img" aria-label="round ${cur} of at most ${max}">${dots}</div>`
}

function ticketButton(t, batch, selectedId) {
  const active = t.id === batch.activeTicketId
  const done = ['accepted', 'committed'].includes(t.status)
  const glyph = done ? 'circle-check' : active ? 'circle-dot' : 'circle'
  const tag = active ? `<span class="tiny-status">${batch.activeKind === 'running' ? 'current' : 'last executed'}</span>` : ''
  return `<button class="ticket ${t.id === selectedId ? 'selected' : ''} ${done ? 'done' : active ? 'running' : ''}" data-select-ticket="${esc(t.id)}" aria-pressed="${t.id === selectedId}"><span class="ticket-icon">${icon(glyph)}</span><span><span class="ticket-id">${esc(t.id)}${tag}</span><span class="ticket-name">${esc(t.title)}</span><span class="small muted">${esc(S.ticketStatus[t.status])}</span></span></button>`
}

function batchFacts(batch, t) {
  const at = f => field(f, v => t.date.format(new Date(v)))
  const rows = [
    ['Run', esc(batch.runId)],
    ['Branch', field(batch.branch)],
    ['Opened', at(batch.openedAt)],
    ['Closed', at(batch.closedAt)],
    ...(batch.phase === 'archived' ? [['Archived', at(batch.archivedAt)]] : []),
    ['Run time', field(batch.runElapsedMs, duration)],
    ['Waiting for PM', field(batch.waitingMs, duration)],
    ['Guardian', field(batch.unattributed.guardian, int)],
    ['Main session', field(batch.unattributed.mainSession, int)],
    ['Reviews', field(batch.unattributed.reviews, int)],
    ['Output (engine)', field(batch.outputTokens, int)],
  ]
  return `<div class="sidefoot"><div>Unattributed tokens are guardian, main session and reviews (${S.tokensUnit}); output is a separate meter.</div><dl class="batch-facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd class="num">${v}</dd>`).join('')}</dl></div>`
}

function sidebar(batch, selectedId, t) {
  const round = batch.roundCurrent.value != null ? `Round ${esc(batch.roundCurrent.value)}` : `Round ${field(batch.roundCurrent)}`
  return `<aside class="sidebar" aria-label="Batch tickets"><div class="side-label">${S.thisBatch}</div>
<div class="round-line"><strong>${round}</strong><span class="muted small">at most ${field(batch.roundCeiling)} rounds</span></div>${roundDots(batch)}
<div class="tickets">${batch.tickets.map(tk => ticketButton(tk, batch, selectedId)).join('')}</div>
<div class="sidefoot">showing ${batch.tickets.length} / ${field(batch.ticketTotal)} tickets · ${field(batch.acceptedCount)} accepted</div>${batchFacts(batch, t)}</aside>`
}

const tone = state => NODE_STATES[state].tone

function nodeButton(n, i, selected) {
  const meta = NODE_STATES[n.state]
  const symbol = meta.symbol ? `<span class="node-symbol" aria-hidden="true">${meta.symbol}</span>` : ''
  const role = `${S.nodeRole[n.key]}${n.model.value ? ` · ${esc(n.model.value)}` : ''}`
  const attempt = n.attempt.value ? `Attempt ${esc(n.attempt.value)}` : n.key === 'commit' ? 'kit step' : S.notDispatched
  return `<button class="node ${tone(n.state)} ${selected ? 'selected' : ''}" data-select-node="${i}" data-node-state="${n.state}" aria-pressed="${selected}" aria-label="${S.nodeTitle[n.key]}: ${S.nodeState[n.state]}">${symbol}<div class="node-title"><span class="node-icon">${icon(S.nodeIcon[n.key])}</span><span>${S.nodeTitle[n.key]}</span></div><div class="node-role">${role}</div><div class="node-footer"><span>${S.nodeState[n.state]}</span><span>${attempt}</span></div></button>`
}

function rework(tk) {
  if (tk.rework === 'none') return ''
  if (tk.rework === 'suggested' && tk.nodes[0].state !== 'done') return `<div class="rework-note" data-rework="suggested">${S.rework.suggestedNoCandidate}</div>`
  return `<div class="return-path ${tk.rework}" data-rework="${tk.rework}"><svg viewBox="0 0 900 40" preserveAspectRatio="none" aria-hidden="true"><path d="M450 0 V8 Q450 24 432 24 H168 Q150 24 150 8 V2" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="M144 8 L150 0 L156 8" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div><div class="return-caption">${S.rework[tk.rework]}</div>`
}

function artifactChip(a) {
  const label = `${esc(a.name)}${a.version ? ` · ${esc(a.version.replace(/^sha256:/, '').slice(0, 8))}` : ''}`
  if (!a.available) return `<span class="artifact missing" title="${esc(a.path)}">${icon('file-text')}${label} · not written</span>`
  return `<a class="artifact" href="${esc(a.href)}" title="${esc(a.path)}">${icon('file-text')}${label}</a>`
}

function detailBlock(n) {
  const parts = []
  if (n.failures.length) parts.push(`<div class="section-label">Failure reasons</div><ul class="failures">${n.failures.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`)
  if (n.detail.value) parts.push(`<details class="detail"><summary>${n.key === 'check' ? 'Commands run' : n.key === 'exec' ? 'Worker notes' : 'Changed paths'}</summary><pre>${esc(n.detail.value)}</pre></details>`)
  if (n.files.value) parts.push(`<div class="event-row">Files touched: ${n.files.value.length ? esc(n.files.value.join(', ')) : 'none'}</div>`)
  return parts.join('')
}

function split(f) {
  if (!f.value) return field(f, String, { reason: true })
  const s = f.value
  return `<span class="field" data-state="${f.state}">in ${int(s.input)} · out ${int(s.output)} · cache write ${int(s.cacheCreate)} · cache read ${int(s.cacheRead)}</span>`
}

function eventRow(event, t) {
  const at = field(event.at, v => t.date.format(new Date(v)))
  if (event.atKind === 'record') return `<div class="event-row"><time>${at}</time><span>${esc(event.text)}</span></div>`
  return `<div class="event-row"><span>Last journal event: ${esc(event.text)}</span><span>First tool call: <time>${at}</time></span></div>`
}

function inspector(n, i, hidden, t) {
  const facts = [
    ['Executor', `${S.nodeRole[n.key]}${n.wrapper.value ? ` · ${esc(n.wrapper.value)}` : ''}`],
    ['Model', field(n.model)],
    ['Attempt', field(n.attempt)],
    ['Status', S.nodeState[n.state]],
    ['Step time', field(n.elapsedMs, duration, { reason: true })],
    [`Tokens · ${S.tokensUnit}`, field(n.tokens, int)],
    ['Output tokens · engine', field(n.outputTokens, int)],
    ['Token split', split(n.split)],
  ]
  return `<section class="inspector" data-panel="${i}" ${hidden ? 'hidden' : ''} aria-label="Step detail"><div class="inspect-head"><div class="flex">${icon('panel-bottom')}<span class="inspect-title">${S.nodeTitle[n.key]}</span></div><span class="small muted">${S.nodeState[n.state]}</span></div>
<div class="inspect-body" aria-live="polite"><div><div class="section-label">Current activity</div><p class="activity">${field(n.activity, String, { reason: true })}</p>${detailBlock(n)}
${eventRow(n.event, t)}
<div class="artifacts">${n.artifacts.map(artifactChip).join('')}</div></div>
<dl class="inspect-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div></section>`
}

function pmBanner(tk, batch) {
  if (!tk.pmPending && !tk.archivedWithoutCommit) return ''
  const lines = [
    ...(tk.pmPending && batch.halt.value ? [`Halt: ${esc(batch.halt.value.reason)}`] : []),
    ...(batch.blockers.value?.length ? [`Blockers: ${batch.blockers.value.map(esc).join(', ')}`] : []),
    ...batch.next.map(n => `Next: ${esc(n)}`),
  ]
  const title = tk.pmPending ? S.pmPending : S.archivedNote
  return `<div class="pm-banner" role="status"><strong>${title}</strong>${tk.pmPending && tk.archivedWithoutCommit ? ` · ${S.archivedNote}` : ''}<ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul></div>`
}

function goalBlock(tk) {
  if (!tk.goal.value) return `<div class="goal">${field(tk.goal, String, { reason: true })}</div>`
  const acceptance = tk.acceptance.length ? `<ul>${tk.acceptance.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''
  return `<details class="goal"><summary><span class="goal-text">${esc(tk.goal.value)}</span><span class="more">Show goal and acceptance</span></summary>${acceptance}</details>`
}

function statusTone(status) {
  if (['failed', 'blocked'].includes(status)) return 'red'
  return ['accepted', 'committed'].includes(status) ? 'green' : ''
}

function ticketView(tk, batch, selectedId, t) {
  const active = tk.id === batch.activeTicketId
  const pill = active ? S.pill[batch.activeKind] : S.pill.viewing
  const back = !active && batch.activeTicketId ? `<button class="return-current" data-select-ticket="${esc(batch.activeTicketId)}">${S.backToCurrent}</button>` : ''
  const focus = tk.nodes[tk.focusNode]
  const attempt = tk.attempt.value ? `Attempt ${esc(tk.attempt.value)}${tk.attemptCeiling.value ? ` of ${esc(tk.attemptCeiling.value)}` : ''}` : S.notDispatched
  const guardian = batch.guardian.value ? `Guardian: ${esc(batch.guardian.value.verdict)}${batch.guardian.value.findings.length ? ` · ${batch.guardian.value.findings.map(esc).join(', ')}` : ''}` : `Guardian: ${field(batch.guardian)}`
  return `<section class="ticket-view" data-ticket="${esc(tk.id)}" ${tk.id === selectedId ? '' : 'hidden'}>
<div class="eyebrow"><span class="pill">${pill}</span><span>${esc(tk.id)}</span><span>·</span><span>${attempt}</span>${back}</div>
<div class="hero"><div><h1>${esc(tk.title)}</h1>${goalBlock(tk)}</div><div class="task-usage"><strong class="num">${field(tk.tokens, int)}</strong><span class="small muted label">ticket tokens · ${S.tokensUnit}</span><span class="small muted label">output ${field(tk.outputTokens, int)} · engine meter</span></div></div>
<div class="hero-meta"><span class="status-chip ${statusTone(tk.status)}" data-status="${tk.status}">${S.ticketStatus[tk.status]}</span><span class="flex">${icon(S.nodeIcon[focus.key])}<span>${S.nodeRole[focus.key]} · ${field(focus.model)}</span></span><span class="flex">${icon('clock-3')}<span>step time ${field(focus.elapsedMs, duration, { reason: true })}</span></span><span>batch run ${field(batch.runElapsedMs, duration)}</span></div>
${pmBanner(tk, batch)}
<section class="canvas" aria-label="Ticket execution path"><div class="canvas-head"><span class="flex">${icon('git-branch')}Execution path</span><span>Select a step for its detail</span></div>
<div class="nodes">${tk.nodes.map((n, i) => nodeButton(n, i, i === tk.focusNode)).join('')}</div>${rework(tk)}
<div class="canvas-bottom"><span>${S.pathNote[tk.status]}</span><span>${guardian}</span></div></section>
${tk.nodes.map((n, i) => inspector(n, i, i !== tk.focusNode, t)).join('')}</section>`
}

function workspace(snap, t) {
  const batch = snap.batch.value
  if (!batch) {
    return `<div class="workspace"><main class="main" style="grid-column:1/-1"><div class="notice" data-batch-state="${snap.batch.state}"><h1>${S.specialist}</h1><p class="muted">${esc(snap.batch.reason)}</p></div></main></div>`
  }
  const selectedId = batch.activeTicketId ?? batch.tickets[0]?.id ?? null
  return `<div class="workspace">${sidebar(batch, selectedId, t)}<main class="main">${batch.tickets.map(tk => ticketView(tk, batch, selectedId, t)).join('')}</main></div>`
}

function footer(snap, t) {
  const found = snap.sources.filter(s => s.found).map(s => s.name), missing = snap.sources.filter(s => !s.found).map(s => s.name)
  return `<footer class="footer"><span>Collected ${esc(t.date.format(new Date(snap.collectedAt)))} · ${esc(snap.timezone)} · static snapshot, regenerate to refresh</span><span>Sources found: ${esc(found.join(', ') || 'none')} · missing: ${esc(missing.join(', ') || 'none')}</span></footer>`
}

export function render(snap) {
  const t = { clock: timeFormat(snap.timezone, false), date: timeFormat(snap.timezone, true) }
  const title = snap.project.name.value ? `AI.Team · ${snap.project.name.value}` : 'AI.Team dashboard'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="dash">${appbar(snap)}${quotaBar(snap, t)}${projectLine(snap)}${workspace(snap, t)}${footer(snap, t)}</div><script>${CLIENT}</script></body></html>
`
}
