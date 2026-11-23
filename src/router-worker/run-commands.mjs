import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { boundLimits } from './switch.mjs';

// ADR 0011, decision 11: the kit, not a reviewer, runs the verification commands, and only one that the batch
// froze and the owner still confirms for the team. Each runs as the PM's user, from the product root.
const TIMEOUT_MS = 15 * 60 * 1000, TAIL = 4000, MODE_FILE = 'profiles/team-mode.json';

// The frozen commands the owner still confirms for the team, by limits a ledger line binds; the others are dropped.
export function confirmedOf(instance, frozen) {
  let profile = null; try { profile = JSON.parse(readFileSync(join(instance, MODE_FILE), 'utf8')); } catch { /* no confirmed command */ }
  const allowed = boundLimits(instance) === digest(profile?.limits) && Array.isArray(profile.limits.allowedCommands) ? profile.limits.allowedCommands : [];
  return { allowed, commands: frozen.filter(command => allowed.includes(command)), dropped: frozen.filter(command => !allowed.includes(command)) };
}

export function runCommands({ productRoot, commands, frozen, allowed, timeoutMs = TIMEOUT_MS }) {
  const unfrozen = commands.find(command => !frozen.includes(command)), unconfirmed = commands.find(command => !allowed.includes(command));
  if (unfrozen !== undefined) return { errors: [{ code: 'COMMAND_REFUSED', field: 'commands', reason: `${unfrozen}: not frozen in this batch; the kit runs no other command` }] };
  if (unconfirmed !== undefined) return { errors: [{ code: 'COMMAND_REFUSED', field: 'commands', reason: `${unconfirmed}: not confirmed for this team by the owner; the kit runs no other command` }] };
  return commands.map(command => {
    const run = spawnSync('/bin/sh', ['-c', command], { cwd: productRoot, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' });
    const output = `${run.stdout ?? ''}${run.stderr ? `\n[stderr]\n${run.stderr}` : ''}`;
    return { command, exit: run.status, timedOut: run.error?.code === 'ETIMEDOUT', outputDigest: digest(output), tail: output.slice(-TAIL) };
  });
}
