import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';

// Registration of the dispatch gate hook in an activated copy, and the check that it is in place.
export const GATE_MATCHER = 'Agent|Task|SendMessage|Workflow|SubagentHandback';
const SETTINGS = '.claude/settings.json';
const refuse = reason => ({ errors: [{ code: 'DISPATCH_GATE_REFUSED', field: 'dispatch', reason }] });
const read = (teamRoot, file) => { try { return JSON.parse(readFileSync(join(teamRoot, file), 'utf8')); } catch { return null; } };

export function armGate({ teamRoot, hookPath }) {
  if (typeof teamRoot !== 'string' || typeof hookPath !== 'string' || !isAbsolute(hookPath)) return refuse('A team root and an absolute hook path are required');
  // Only a disposable activated copy is written; a standing instance keeps its settings.
  if (read(teamRoot, 'profiles/team-mode.json')?.status !== 'activated-disposable-smoke') return refuse('The team root is not an activated disposable copy');
  const path = join(teamRoot, SETTINGS), present = lstatSync(path, { throwIfNoEntry: false }), settings = present ? read(teamRoot, SETTINGS) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return refuse(`${SETTINGS} is not a JSON object`);
  const command = `node "${hookPath}"`, existing = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  if (!existing.some(entry => entry?.matcher === GATE_MATCHER && entry.hooks?.some(hook => hook?.command === command)))
    writeFileSync(path, JSON.stringify({ ...settings, hooks: { ...settings.hooks, PreToolUse: [...existing, { matcher: GATE_MATCHER, hooks: [{ type: 'command', command }] }] } }, null, 2) + '\n');
  return { armed: true };
}

// Why the gate of this team root is not in place; null when it is.
export function gateGap({ teamRoot }) {
  const files = [SETTINGS, '.claude/settings.local.json'].map(file => read(teamRoot, file));
  if (files.some(file => file?.disableAllHooks)) return 'hooks are disabled in the team root';
  const entries = Array.isArray(files[0]?.hooks?.PreToolUse) ? files[0].hooks.PreToolUse : [];
  const hooked = entries.some(entry => entry?.matcher === GATE_MATCHER && Array.isArray(entry.hooks) && entry.hooks.some(hook => {
    const path = hook?.type === 'command' && /^node "([^"]+)"$/.exec(hook.command ?? '')?.[1];
    return path && basename(path) === 'rw-dispatch-gate.mjs' && lstatSync(path, { throwIfNoEntry: false })?.isFile();
  }));
  return hooked ? null : 'the dispatch gate hook is not registered, or its file is missing';
}
