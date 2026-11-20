import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../loop/contracts.mjs';

// ADR 0011, decisions 1, 3 and 8 to 10: the list of triggers and rules that decides which reviewer a batch's
// changes require. The kit ships a general part and names the reviewers; the team's folder holds the project's part.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const KIT_REVIEW = 'config/router-worker/review.json', PROJECT_REVIEW = 'profiles/review.json', LAST_FROZEN = 'reviews/frozen-last.json';
const SEED = 'kit/profiles/review.template.json', LEDGER = 'pm-decisions.md', ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, KINDS = ['glob', 'contains'], SHOWN = 20;

class ReviewListError extends Error {}
const need = (condition, reason) => { if (!condition) throw new ReviewListError(reason); };
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const list = (value, check) => Array.isArray(value) && value.every(check);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const plainName = name => typeof name === 'string' && ID.test(name) ? name : '(none or not a name)';
const relativePath = path => text(path, 200) && !path.startsWith('/') && !path.split('/').includes('..');

// One part of the list. Kit ids start with "kit.", project ids never do, so neither part can replace the other's entries.
function checkPart(part, { kit, reviewers }) {
  need(shape(part, kit ? ['schemaVersion', 'reviewers', 'triggers', 'rules', 'adrs'] : ['schemaVersion', 'triggers', 'rules', 'adrs']) && part.schemaVersion === 1,
    `it must hold exactly schemaVersion 1, ${kit ? 'reviewers, ' : ''}triggers, rules and adrs`);
  const own = id => ID.test(id ?? '') && id.startsWith('kit.') === kit, named = kit ? 'start with "kit."' : 'not start with "kit."';
  const known = names => list(names, name => reviewers.includes(name)) && names.length > 0 && new Set(names).size === names.length;
  need(Array.isArray(part.triggers), 'triggers must be a list');
  for (const trigger of part.triggers) {
    need(shape(trigger, ['id', 'reviewers', 'match']) && own(trigger.id), `each trigger holds id, reviewers and match, and its id is a plain identifier that must ${named}`);
    need(known(trigger.reviewers), `trigger ${trigger.id}: reviewers must name, once each, a reviewer of the kit (${reviewers.join(', ')}); reviewer ${plainName(Array.isArray(trigger.reviewers) ? trigger.reviewers.find(name => !reviewers.includes(name)) : null)} is not one`);
    const kinds = trigger.match && typeof trigger.match === 'object' && !Array.isArray(trigger.match) ? Object.keys(trigger.match) : [];
    need(kinds.length > 0 && kinds.every(kind => KINDS.includes(kind) && list(trigger.match[kind], pattern => relativePath(pattern)) && trigger.match[kind].length > 0),
      `trigger ${trigger.id}: match holds glob or contains, each a non-empty list of relative patterns`);
  }
  need(list(part.rules, rule => shape(rule, ['id', 'reviewer', 'text']) && own(rule.id) && reviewers.includes(rule.reviewer) && text(rule.text, 500)),
    `each rule holds an id that must ${named}, a reviewer of the kit (${reviewers.join(', ')}) and one line of text of at most 500 characters`);
  need(list(part.adrs, relativePath), 'adrs must list paths relative to the team folder');
}
const read = (path, name, fix) => {
  let bytes;
  try { bytes = readFileSync(path, 'utf8'); } catch { need(false, `${name} is missing. ${fix}`); }
  try { return JSON.parse(bytes); } catch { need(false, `${name} is not valid (not JSON). ${fix}`); }
};

// The merged list a batch freezes, with its digest. A refusal names the file and the fix.
export function loadReview({ instance, kit = ROOT, projectFile = join(instance, PROJECT_REVIEW) }) {
  const general = read(join(kit, KIT_REVIEW), `kit/${KIT_REVIEW}`, 'The kit checkout is broken; restore it from the pinned kit');
  need(list(general?.reviewers, name => ID.test(name)) && general.reviewers.length > 0, `kit/${KIT_REVIEW} does not name the reviewers`);
  const { reviewers } = general;
  try { checkPart(general, { kit: true, reviewers }); } catch (error) { need(false, `kit/${KIT_REVIEW} is not valid: ${error.message}`); }
  const fix = `Security and Architect propose the project's triggers and rules, the owner confirms them; to start from the empty seed: cp ${SEED} ${PROJECT_REVIEW}`;
  const project = read(projectFile, PROJECT_REVIEW, fix);
  try { checkPart(project, { kit: false, reviewers }); } catch (error) { need(false, `${PROJECT_REVIEW} is not valid: ${error.message}. ${fix}`); }
  const body = { reviewers, triggers: [...general.triggers, ...project.triggers], rules: [...general.rules, ...project.rules], adrs: [...new Set([...general.adrs, ...project.adrs])] };
  const ids = [...body.triggers, ...body.rules].map(entry => entry.id.toLowerCase()), twice = ids.find((id, i) => ids.indexOf(id) !== i);
  need(!twice, `${PROJECT_REVIEW} is not valid: the id ${twice} is used twice. ${fix}`);
  return { ...body, digest: digest(body) };
}
export const isReviewListError = error => error instanceof ReviewListError;

// Each pattern, reviewer and rule as one line, so a narrowed trigger shows as the patterns it lost.
const atoms = review => [
  ...review.triggers.flatMap(trigger => trigger.reviewers.flatMap(reviewer => KINDS.flatMap(kind => (trigger.match[kind] ?? []).map(pattern => ({ key: `trigger ${trigger.id} ${reviewer} ${kind}:${pattern}` }))))),
  ...review.rules.map(rule => ({ key: `rule ${rule.id} ${rule.reviewer}`, same: digest(rule) })),
  ...review.adrs.map(path => ({ key: `adr ${path}` }))];
const minus = (a, b) => a.filter(atom => !b.some(other => other.key === atom.key && other.same === atom.same)).map(atom => atom.key);
const shown = keys => `${keys.slice(0, SHOWN).map(key => key.replace(/[\x00-\x1f\x7f]/g, '?')).join(', ')}${keys.length > SHOWN ? `, ... (${keys.length} in all)` : ''}`;

// What changed since the list the last batch froze. A rule whose text changed is both removed and added.
export function triggerChanges(instance, review) {
  let previous = null;
  try { const kept = JSON.parse(readFileSync(join(instance, LAST_FROZEN), 'utf8')), { digest: was, ...body } = kept; previous = was === digest(body) ? kept : null; } catch { /* none kept */ }
  return previous ? { previous: previous.digest, added: minus(atoms(review), atoms(previous)), removed: minus(atoms(previous), atoms(review)) } : { previous: null, added: [], removed: [] };
}
// Called once the batch record is written. With no earlier list kept, the whole list goes to the owner's spot review.
export function recordFrozen({ instance, review, changes, runId, at }) {
  const day = at.slice(0, 10), lines = changes.previous
    ? [changes.added.length ? `${day} BATCH ${runId} REVIEW TRIGGERS ADDED: ${shown(changes.added)}.` : null, changes.removed.length ? `${day} BATCH ${runId} REVIEW TRIGGERS REMOVED (owner spot review): ${shown(changes.removed)}.` : null].filter(Boolean)
    : [`${day} BATCH ${runId} REVIEW TRIGGERS FROZEN with no earlier list kept in ${LAST_FROZEN} (owner spot review): ${review.triggers.length} trigger(s), ${review.rules.length} rule(s), ${review.adrs.length} ADR(s), ${review.digest}.`];
  if (lines.length) appendFileSync(join(instance, LEDGER), lines.map(line => `${line}\n`).join(''));
  if (changes.previous !== review.digest) {
    mkdirSync(join(instance, 'reviews'), { recursive: true });
    writeFileSync(join(instance, `${LAST_FROZEN}.tmp`), JSON.stringify(review, null, 2) + '\n'); renameSync(join(instance, `${LAST_FROZEN}.tmp`), join(instance, LAST_FROZEN));
  }
}

// A glob matches the whole path: `**/` is any number of folders, `*` and `?` stay inside one. Case is ignored, as in `covers`.
const globOf = pattern => new RegExp(`^${pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(part => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')}$`, 'i');
const hits = (match, path) => (match.glob ?? []).some(pattern => globOf(pattern).test(path)) || (match.contains ?? []).some(word => path.toLowerCase().includes(word.toLowerCase()));

// The reviewers a ticket's changed paths require, in the kit's order, and why.
export function flagPaths(review, paths) {
  const because = paths.flatMap(path => review.triggers.filter(trigger => hits(trigger.match, path)).flatMap(trigger => trigger.reviewers.map(reviewer => ({ reviewer, trigger: trigger.id, path }))));
  return { required: review.reviewers.filter(name => because.some(entry => entry.reviewer === name)), because, flaggedFiles: [...new Set(because.map(entry => entry.path))] };
}
