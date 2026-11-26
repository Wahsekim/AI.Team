// A live Router/Worker team with a batch run by the real engine on mock agents, and reviewer transcripts as Claude Code
// writes them, for the tests of the batch review (ADR 0011).
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeBatch } from '../../../src/router-worker/batch.mjs';
import { commitBatch } from '../../../src/router-worker/batch-close.mjs';
import { reviewBrief } from '../../../src/router-worker/review-brief.mjs';
import { judgeReview, recordNoAnswer } from '../../../src/router-worker/review-judge.mjs';
import { resolveBatch } from '../../../src/router-worker/review-resolve.mjs';
import { readBoundary } from '../../../src/router-worker/write-boundary.mjs';
import { runWorkflow, makeAgentImpl } from '../../../scripts/lib/workflow-harness.mjs';
import { fixture, git, checksRan, afterBatch } from './standing-team.mjs';

export const refusal = result => result.errors?.[0];
export const ticket = (id, paths, extra = {}) => ({ id, title: `Ticket ${id}`, goal: `Goal of ${id}`, acceptance: [`${id} acceptance holds`], paths, estimate: { execTokens: 12000, checkTokens: 6000, reworkTokens: 6000 }, ...extra });
export const COMMANDS = ['echo verified-by-kit', 'pwd'];
export const batchOf = (...tickets) => ({ tickets, verificationCommands: COMMANDS, sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 1 });
export const agentsOf = commands => ({ worker: () => ({ outcome: 'done', progress: true, filesTouched: [], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'done' }),
  verifier: () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: commands.map(command => ({ command, exitCode: 0 })), failures: [] }) });

// `commands`: the verification commands the batch freezes and the owner confirms, or a function of the fixture's base folder.
export function live(t, { commands = COMMANDS, blank = false } = {}) {
  const f = fixture(t, { blank }), confirmed = typeof commands === 'function' ? commands(f.base) : commands;
  assert.equal(f.apply('router-worker', { spec: f.spec, limits: { allowedCommands: confirmed } }).errors, undefined); git(f.product, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(f.root, 'profiles/review.json'), JSON.stringify({ schemaVersion: 1, triggers: [], rules: [], adrs: [] }));
  const common = { teamRoot: f.kit, instanceRoot: f.root }, projectsRoot = join(f.base, 'projects');
  return { ...f, common, projectsRoot, commands: confirmed,
    before: batch => beforeBatch({ ...common, batch }),
    brief: (reviewer, tickets) => reviewBrief({ ...common, reviewer, ...(tickets ? { tickets } : {}) }),
    judge: (reviewer, transcript, report) => judgeReview({ ...common, reviewer, transcript, projectsRoot, ...(report ? { report } : {}) }),
    noAnswer: (reviewer, reason) => recordNoAnswer({ ...common, reviewer, reason, projectsRoot }),
    resolve: () => resolveBatch(common),
    commit: () => commitBatch(common), state: () => readBoundary(f.root)?.state, ledger: () => f.read('pm-decisions.md'),
    lines: file => existsSync(join(f.root, file)) ? f.read(file).split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
}
export const changed = f => git(f.product, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map(line => line.slice(3)).sort();
// A batch run by the real engine with mock agents and left for after; `edits` is what the workers leave in the product (a text,
// a Buffer of bytes, or { link } for a symbolic link), `fields` other batch fields, `agents` mock agents in the place of the default ones.
export async function engineRun(f, tickets, edits, fields = {}, agents = {}) {
  const open = await f.before({ ...batchOf(...tickets), verificationCommands: f.commands, ...fields });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  // The Guardian's brief names the run; settle reads it from the Guardian's transcript.
  let guardianBrief = null; const mock = makeAgentImpl({ ...agentsOf(f.commands), ...agents }), agentImpl = (prompt, opts, index) => { if (opts?.schema?.required?.includes('runawayDetected')) guardianBrief = prompt; return mock(prompt, opts, index); };
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl });
  for (const [path, text] of Object.entries(edits)) { mkdirSync(join(f.product, path, '..'), { recursive: true }); if (typeof text === 'string' || Buffer.isBuffer(text)) writeFileSync(join(f.product, path), text); else symlinkSync(text.link, join(f.product, path)); }
  checksRan(f.root, open);
  return { open, result, guardianBrief };
}
// The same batch closed by after.
export async function runBatch(f, ...args) {
  const { open, result, guardianBrief } = await engineRun(f, ...args), after = afterBatch({ ...f.common, result });
  assert.equal(after.errors, undefined, JSON.stringify(after.errors));
  return { open, after, guardianBrief };
}
export const edits = paths => Object.fromEntries(paths.map(path => [path, `// ${path}\n`]));

// The report a reviewer returns when every flagged file was read and every rule passes.
export function reportOf(made) {
  const r = made.record;
  return { schemaVersion: 1, reviewer: r.reviewer, briefDigest: r.briefDigest,
    filesRead: r.tickets.flatMap(item => item.flaggedFiles.map(path => ({ path, read: true }))),
    rules: r.tickets.flatMap(item => r.ruleIds.map(rule => ({ rule, ticket: item.id, result: 'pass', file: item.flaggedFiles[0], line: 1, note: 'checked' }))),
    items: r.tickets.map(item => ({ ticket: item.id, verdict: 'GREEN', finding: 'nothing found', fix: '', control: null })), residualRisk: 'none' };
}
export const CONTROL = { detects: 'a string literal assigned to a token variable', variation: 'the same literal in a test fixture', toolCanDetect: true };
export const failing = (report, id, rule, item = {}) => ({ ...report,
  rules: report.rules.map(row => row.ticket === id && row.rule === rule ? { ...row, result: 'fail', note: 'a token is written in code' } : row),
  items: report.items.map(entry => entry.ticket === id ? { ...entry, verdict: 'RED', finding: 'a token is written in code', fix: 'read it from the environment', control: CONTROL, ...item } : entry) });

let agentSeq = 0;
// A reviewer's transcript as Claude Code writes it for an Agent-tool subagent: the brief as the prompt, one Read per
// flagged file and its result, the report as the last fenced json block of the final message, and the meta file naming
// the wrapper. A read is a path, or { path, input, error } for a partial or failed Read; `report: null` is a reviewer that
// stopped without one. Each transcript is dispatched after the one made before it.
export function transcriptOf(f, made, { report = reportOf(made), reads, agentType = made.record.wrapper, workflow = false, prompt = `Review this batch.\n\n${made.brief}`, session = 'session-1' } = {}) {
  const folder = join(f.projectsRoot, '-fixture-team', session, 'subagents', ...(workflow ? ['workflows', 'wf_1'] : [])), id = `agent-a${++agentSeq}`;
  const opened = reads ?? made.record.tickets.flatMap(item => item.flaggedFiles.filter(path => item.content[path] !== null).map(path => join(f.product, path)));
  const rows = [{ type: 'user', isSidechain: true, timestamp: new Date(Date.now() + agentSeq).toISOString(), message: { role: 'user', content: prompt } },
    { type: 'attachment', attachment: {} },
    ...opened.map(read => typeof read === 'string' ? { path: read } : read).flatMap(({ path, input = {}, error = false }, i) => [
      { type: 'assistant', message: { id: 'msg_reads', role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: path, ...input } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: error ? 'File does not exist.' : '1\tcode', ...(error ? { is_error: true } : {}) }] } }]),
    { type: 'assistant', message: { id: 'msg_report', role: 'assistant', content: [{ type: 'text', text: report === null ? 'Out of turns before the report.' : `Review done.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n` }] } }];
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(folder, `${id}.meta.json`), JSON.stringify({ agentType, description: 'review' }));
  return join(folder, `${id}.jsonl`);
}
