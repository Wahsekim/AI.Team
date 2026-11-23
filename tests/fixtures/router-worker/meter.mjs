import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The session's transcripts as the runtime leaves them, read by the kit's meter: one agent per call, in the engine's order.
const METER = fileURLToPath(new URL('../../../scripts/measure-spawn.mjs', import.meta.url));
export function meterOf(f, tokens, { briefOf = brief => brief, guardBrief = f.guardianBrief, request = 'run the batch', session = 'sess', wf = 'wf_1', ticketsRun = f.open.args.plan.length } = {}) {
  const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n', dir = join(f.base, 'projects'), folder = join(dir, `${session}/subagents/workflows/${wf}`);
  const usage = (id, agentId, create) => ({ type: 'assistant', isSidechain: Boolean(agentId), agentId, requestId: `req_${id}`, message: { id: `msg_${id}`, model: 'm', role: 'assistant', content: [],
    usage: { input_tokens: 10, cache_creation_input_tokens: create, cache_read_input_tokens: 0, output_tokens: 100 } } });
  const indented = text => text.split('\n').map(line => '  ' + line).join('\n'), relayed = text => ({ type: 'user', message: { role: 'user', content: `[Workflow harness — computed task] The task text follows:\n${indented(text)}\n  ` } });
  const asked = { type: 'user', message: { role: 'user', content: `[Workflow harness — user request] The harness relays what the user asked:\n${indented(request)}` } };
  const agents = [...f.open.args.plan.slice(0, ticketsRun).flatMap((item, i) => [[`${wf}-exec${i}`, item.agentType, briefOf(item.brief)], [`${wf}-check${i}`, item.verifierAgentType, briefOf(item.verifierBrief)]]), [`${wf}-guard`, f.open.args.guardianAgentType, guardBrief]];
  mkdirSync(folder, { recursive: true }); writeFileSync(join(dir, `${session}.jsonl`), jsonl([usage('main', undefined, 7000)]));
  agents.forEach(([id, agentType, brief], i) => {
    writeFileSync(join(folder, `agent-${id}.jsonl`), jsonl([asked, relayed(brief), usage(id, id, tokens[i])]));
    writeFileSync(join(folder, `agent-${id}.meta.json`), JSON.stringify({ agentType, description: id }));
  });
  writeFileSync(join(folder, 'journal.jsonl'), jsonl([{ type: 'launched' }, ...agents.flatMap(([agentId]) => [{ type: 'started', agentId }, { type: 'result', agentId, result: {} }])]));
  const run = spawnSync(process.execPath, [METER, join(dir, session), '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
