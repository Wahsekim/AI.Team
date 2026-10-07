// Human-readable task presentation (review 2026-09-25, F-05/F-06).
// IDs stay identity; everything here is presentation and MUST NOT feed
// routing, permissions, dependency selection, budget admission, or evidence
// matching. The label formatter is duplicated VERBATIM inside
// .claude/workflows/run-n-rounds.js (workflow bodies cannot import modules);
// tests/loop-display.test.mjs asserts parity between the two copies.

export const WORK_KINDS = Object.freeze(['feature', 'screen', 'protocol', 'infrastructure', 'test', 'documentation', 'maintenance', 'mixed', 'unspecified']);
export const PHASES = Object.freeze(['Build', 'Verify', 'Audit', 'Repair', 'Recover']);
export const MAX_TITLE_CHARS = 120;
export const MAX_TICKET_CHARS = 200;
export const MAX_LAYERS = 8;
export const MAX_LAYER_CHARS = 32;
export const DEFAULT_LABEL_WIDTH = 80;
const LAYER = /^[A-Za-z0-9._/-]+$/;
const SEP = ' · ';

// ---- BEGIN formatter (mirrored in run-n-rounds.js — keep byte-identical modulo the export keyword) ----
// Terminal escapes first (CSI, OSC, single-char ESC sequences), then every
// remaining control character becomes a space, then whitespace collapses.
const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-_]/g;
const CTRL_ALL = /[\x00-\x1F\x7F]/g;
const cps = s => Array.from(s);
export const sanitizeDisplay = (s, max) => {
  const clean = String(s ?? '').replace(ANSI, '').replace(CTRL_ALL, ' ').replace(/\s+/g, ' ').trim();
  return cps(clean).slice(0, max).join('');
};
export const formatTaskLabel = (task, phase, widthBudget = 80) => {
  const ticket = sanitizeDisplay(task && task.ticket, 200) || '(no ticket)';
  const phaseWord = sanitizeDisplay(phase, 20) || 'Work';
  let title = task && task.title != null ? sanitizeDisplay(task.title, 120) : '';
  const join = t => (t ? [ticket, t, phaseWord] : [ticket, phaseWord]).join(' · ');
  let label = join(title);
  if (title && cps(label).length > widthBudget) {
    const room = widthBudget - cps(ticket).length - cps(phaseWord).length - 2 * ' · '.length;
    title = room >= 2 ? cps(title).slice(0, room - 1).join('') + '…' : '';
    label = join(title);
  }
  return label;
};
// ---- END formatter ----

export function validateTaskDisplay(display, label = 'display') {
  const problems = [];
  if (!display || typeof display !== 'object' || Array.isArray(display)) return [`${label}: object required`];
  const known = ['ticket', 'title', 'workKind', 'layers'];
  for (const k of Object.keys(display)) if (!known.includes(k)) problems.push(`${label}.${k}: unknown field`);
  const plain = (v, max, name) => {
    if (typeof v !== 'string' || v.trim().length === 0) return `${label}.${name}: nonempty string required`;
    if (cps(v).length > max) return `${label}.${name}: longer than ${max} characters`;
    if (/[\x00-\x1F\x7F]/.test(v)) return `${label}.${name}: control characters are not allowed`;
    return null;
  };
  const t = plain(display.ticket, MAX_TICKET_CHARS, 'ticket'); if (t) problems.push(t);
  const ti = plain(display.title, MAX_TITLE_CHARS, 'title'); if (ti) problems.push(ti);
  if (!WORK_KINDS.includes(display.workKind)) problems.push(`${label}.workKind: one of ${WORK_KINDS.join('|')} required`);
  if (!Array.isArray(display.layers) || display.layers.length > MAX_LAYERS) problems.push(`${label}.layers: array of at most ${MAX_LAYERS} required`);
  else {
    display.layers.forEach((l, i) => {
      if (typeof l !== 'string' || l.length === 0 || l.length > MAX_LAYER_CHARS || !LAYER.test(l)) problems.push(`${label}.layers[${i}]: identifier of at most ${MAX_LAYER_CHARS} chars matching [A-Za-z0-9._/-] required`);
    });
    if (new Set(display.layers).size !== display.layers.length) problems.push(`${label}.layers: duplicate entries`);
  }
  return problems;
}

// Markdown-safe fallback text for renderers: never invent a title.
export const displayTitleOrFallback = display => (display && typeof display.title === 'string' && display.title.trim() ? sanitizeDisplay(display.title, MAX_TITLE_CHARS) : '(no title)');

// R04b: recorded (store) vs observed (active driver) vs cancellation state, derived from durable state only.
// Cancellation is confirmed only when the observed stop leaves no running or unknown work.
export function stopView(state) {
  const record = state.stopRequest ?? null, failed = state.stopObserverFailed?.recoveredAt ? null : state.stopObserverFailed ?? null;
  if (!record && !failed) return null;
  const seq = record ? record.seq ?? 1 : null, kind = record ? record.kind ?? record.mode : null;
  const observed = !!record && state.stopObserved?.seq === seq;
  const running = Object.values(state.dispatches).some(d => !d.receipt && d.status === 'STARTED') || state.projection?.status === 'STARTED';
  const cancellation = kind !== 'hard' ? null : state.status === 'RECOVERY_REQUIRED' ? 'unconfirmed'
    : ['COMPLETED', 'STOPPED', 'FAILED'].includes(state.status) || observed && !running ? 'confirmed' : 'pending';
  return { recorded: !!record, seq, kind, observed, cancellation, keptProjection: state.projection?.keptByStop === seq && !!record,
    observerFailed: failed ? { cause: failed.cause, at: failed.at } : null };
}

// Read-only text projection of store.status(runId). Never touches the store.
export function renderRunSummary(status, { width = 80 } = {}) {
  const w = Math.max(40, width);
  // Sanitize per part, then join on two spaces: sanitizeDisplay would collapse the column gap.
  const line = (...parts) => cps(parts.map(p => sanitizeDisplay(p, w)).filter(Boolean).join('  ')).slice(0, w).join('');
  const { spec, state } = status;
  const lines = [];
  if (status.simulation) lines.push('SIMULATION — not evidence of a real product build');
  lines.push(line(`run ${status.runId} · ${state.status} · v${status.stateVersion}`));
  const stop = state.stopRequest;
  if (stop) lines.push(line(stop.kind ? `stop ${stop.kind} · #${stop.seq} · by ${stop.requestedBy}` : `stop ${stop.mode} · legacy record`));
  const view = stopView(state);
  if (view?.recorded) lines.push(line(view.observed ? `stop observed by the driver · #${view.seq}` : 'stop recorded · not yet observed by a driver',
    view.cancellation === 'unconfirmed' ? 'cancellation unconfirmed · recovery required' : view.cancellation ? `cancellation ${view.cancellation}` : '',
    view.keptProjection ? 'closing projection kept' : ''));
  if (view?.observerFailed) lines.push(line(`STOP_OBSERVER_FAILED · ${view.observerFailed.cause} · driver stopped new work`));
  for (const task of spec.tasks) {
    const t = state.tasks[task.id];
    const display = spec.schemaVersion === 2 ? task.display : null;
    lines.push(line(display ? display.ticket : task.id, displayTitleOrFallback(display), t.status));
    lines.push(line(display ? `${display.workKind} · ${display.layers.join('/') || '-'}` : 'unspecified · -', `role ${task.roleId}`, `attempts ${t.attempts}/${task.maxAttempts}`));
    lines.push(line(task.requiredGateIds.map(g => `gate ${g}: ${t.gates[g] === state.candidate ? 'passed' : 'pending'}`).join(' · ') || 'no gates'));
  }
  return `${lines.join('\n')}\n`;
}
