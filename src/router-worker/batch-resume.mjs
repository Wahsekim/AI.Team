// ADR 0010, amendment of 2026-11-25: a ticket resumes the work an earlier batch left, from a patch in the team
// root. "before" applies it to the product, so what it changes is the ticket's and goes through check and review.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, isAbsolute, sep } from 'node:path';
import { bytesDigest } from '../loop/contracts.mjs';
import { gitRun } from './lease.mjs';
import { within } from './write-boundary.mjs';

const CONTROL = /[\x00-\x1f\x7f]/;
// What git apply --summary prints for a change other than an edit or a new regular file.
const NOT_AN_EDIT = /^ (delete mode|rename |copy |mode change|create mode (?!100644 ))/m;
const MAX_RESUMED = 100;
const fold = path => path.normalize('NFC').toLowerCase();
const firstLine = text => String(text ?? '').trim().split('\n')[0].replace(/[\x00-\x1f\x7f-\x9f]/g, '?').slice(0, 200);

export function resumePathProblem(ticket) {
  const path = ticket.resume;
  if (path === undefined) return null;
  const plain = typeof path === 'string' && path.length > 0 && path.length <= 512 && !isAbsolute(path) && !CONTROL.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..') && path.split('/')[0].toLowerCase() !== 'kit';
  return plain ? null : `Ticket ${ticket.id}: resume must name a patch file inside the team root, by a relative path outside kit/ ("handoff/T-1/left.patch")`;
}

// {problem} or {plan: {patch, digest, paths, bytes}}: the patch as read once, so what was checked is what is applied.
export function resumePlan({ instance, productRoot, ticket }) {
  const file = join(instance, ticket.resume), root = realpathSync(instance);
  let stat = null;
  try { stat = lstatSync(file, { throwIfNoEntry: false }); } catch { /* a part of the path is a file */ }
  if (!stat?.isFile() || !realpathSync(file).startsWith(root + sep) || realpathSync(file).startsWith(join(root, 'kit') + sep))
    return { problem: `Ticket ${ticket.id} resumes ${ticket.resume}, which is not a file of the team root (a link is not followed)` };
  const bytes = readFileSync(file);
  if (!bytes.toString('utf8').trim()) return { problem: `Ticket ${ticket.id} resumes ${ticket.resume}, which changes nothing a ticket can commit` };
  const apply = args => gitRun(productRoot, ['apply', ...args, '-'], { input: bytes });
  const listed = apply(['--numstat', '-z']), summary = apply(['--summary']);
  if (listed.status !== 0 || summary.status !== 0) return { problem: `Ticket ${ticket.id} resumes ${ticket.resume}, which is not a patch Git can read: ${firstLine(listed.stderr || summary.stderr)}` };
  if (NOT_AN_EDIT.test(summary.stdout)) return { problem: `Ticket ${ticket.id} resumes ${ticket.resume}, which deletes, renames, copies or changes the mode of a file, or creates a link: a resumed patch only edits and adds regular files. Declare moves and deletes on the ticket instead` };
  // With -z Git writes each path unquoted after the second tab, so a tab inside a path stays part of it.
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean).map(entry => entry.split('\t').slice(2).join('\t')))].sort();
  if (!paths.length || paths.some(path => !path)) return { problem: `Ticket ${ticket.id} resumes ${ticket.resume}, which changes nothing a ticket can commit` };
  const odd = paths.find(path => CONTROL.test(path) || path.includes('\ufffd'));
  if (odd !== undefined) return { problem: `Ticket ${ticket.id} resumes a patch that changes a path with a control character or bytes that are not UTF-8 (${firstLine(JSON.stringify(odd))})` };
  if (paths.length > MAX_RESUMED) return { problem: `Ticket ${ticket.id} resumes a patch that changes ${paths.length} paths; at most ${MAX_RESUMED}` };
  // The same comparison "after" makes, so every resumed path is counted as the ticket's.
  const outside = paths.find(path => !within(path, ticket.paths));
  if (outside) return { problem: `Ticket ${ticket.id} resumes a patch that changes ${outside}, outside its paths; add it to the ticket's paths` };
  const declared = new Set([...(ticket.moves ?? []).flatMap(move => [move.from, move.to]), ...(ticket.deletes ?? [])].map(fold));
  const moved = paths.find(path => declared.has(fold(path)));
  if (moved) return { problem: `Ticket ${ticket.id} resumes a patch that changes ${moved}, which it also moves or deletes: its Git command would fail on the changed file. Leave it out of the patch, or out of the moves and deletes` };
  // Git status does not list an ignored file, so "after" and "commit" would never see a change to it.
  const ignored = gitRun(productRoot, ['check-ignore', '-z', '--stdin'], { input: paths.join('\0') }).stdout?.split('\0').find(Boolean);
  if (ignored) return { problem: `Ticket ${ticket.id} resumes a patch that changes ${ignored}, which Git ignores: after and commit would never see it` };
  const check = apply(['--check']);
  if (check.status !== 0) return { problem: `Ticket ${ticket.id} resumes ${ticket.resume}, which does not apply on the product's HEAD: ${firstLine(check.stderr)}. Make the patch again from the work it holds, on this HEAD` };
  return { plan: { patch: ticket.resume, digest: bytesDigest(bytes), paths, bytes } };
}

export function applyResume(productRoot, plan) {
  const applied = gitRun(productRoot, ['apply', '-'], { input: plan.bytes });
  if (applied.status !== 0) throw Object.assign(new Error(`The patch ${plan.patch} could not be applied: ${firstLine(applied.stderr)}`), { code: 'RESUME_NOT_APPLIED' });
}
// Takes an applied patch back out of the work tree when the batch does not open after all.
export const revertResume = (productRoot, plan) => gitRun(productRoot, ['apply', '-R', '-'], { input: plan.bytes }).status === 0;
