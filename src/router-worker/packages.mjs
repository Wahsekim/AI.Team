import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { bytesDigest } from '../loop/contracts.mjs';
import { relativePath, globOf } from './review-triggers.mjs';
import { TICKET_ID, overlap } from './batch.mjs';
import { MAX_CONVENTIONS_BYTES } from './compile.mjs';

// ADR 0010, amendment of 2026-11-27: the packages of one product repository, each a folder with its own conventions, verification
// commands and interface files. The file is optional; a team without it has no packages.
export const PACKAGES = 'profiles/packages.json';
const KEYS = ['name', 'dir', 'conventions', 'verificationCommands', 'interfaces'];
const FIX = 'Its shape is in docs/design/router-worker/batch-reference.md, "Packages of one repository"; a team without packages has no such file';
const SHARED = 'one ticket per package; what two packages share goes through an interface file with a ticket of its own and dependsOn';

class PackagesError extends Error {}
export const isPackagesError = error => error instanceof PackagesError;
const need = (condition, reason) => { if (!condition) throw new PackagesError(reason); };
const strings = value => Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string' && entry) && new Set(value).size === value.length;
const folder = dir => relativePath(dir) && !/[*?[\]{}\\:]/.test(dir) && dir.split('/').every(part => part && part !== '.' && part === part.trim());
const inside = (root, path) => { try { return realpathSync(join(root, path)) === join(realpathSync(root), path); } catch { return false; } };

function conventionsOf(instance, entry) {
  const path = entry.conventions, at = `package ${entry.name}`;
  need(relativePath(path) && path.split('/')[0].toLowerCase() !== 'kit', `${at}: conventions must be a path in the team's own folder, not under kit/, with no ".."`);
  const stat = lstatSync(join(instance, path), { throwIfNoEntry: false });
  need(stat, `${at}: the conventions file ${path} is missing`);
  need(stat.isFile() && inside(instance, path), `${at}: the conventions file ${path} is not a regular file in the team's folder (a link is not followed)`);
  need(stat.size <= MAX_CONVENTIONS_BYTES, `${at}: the conventions file ${path} holds ${stat.size} bytes, more than ${MAX_CONVENTIONS_BYTES}`);
  const bytes = readFileSync(join(instance, path));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { text = null; }
  need(text !== null && !text.includes('\0'), `${at}: the conventions file ${path} is not UTF-8 text`);
  need(text.trim(), `${at}: the conventions file ${path} is empty; write the package's rules in it, or leave conventions out`);
  return { path, digest: bytesDigest(bytes), text };
}

function checkPackage(instance, productRoot, entry) {
  need(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).every(key => KEYS.includes(key)) && typeof entry.name === 'string' && TICKET_ID.test(entry.name),
    `each package holds a name (1 to 40 letters, digits, dots, dashes or underscores), a dir, and optionally conventions, verificationCommands and interfaces`);
  const at = `package ${entry.name}`;
  need(typeof entry.dir === 'string' && folder(entry.dir), `${at}: dir must be a folder of the product repository, relative, with no "..", no "." and no pattern`);
  need(lstatSync(join(productRoot, entry.dir), { throwIfNoEntry: false })?.isDirectory() && inside(productRoot, entry.dir), `${at}: dir ${entry.dir} is not a folder of the product repository (a link is not followed)`);
  need(entry.verificationCommands === undefined || strings(entry.verificationCommands), `${at}: verificationCommands must list commands, each once`);
  need(entry.interfaces === undefined || (strings(entry.interfaces) && entry.interfaces.every(relativePath)), `${at}: interfaces must list relative glob patterns of the product, each once`);
  return { name: entry.name, dir: entry.dir, interfaces: entry.interfaces ?? [], ...(entry.verificationCommands ? { verificationCommands: entry.verificationCommands } : {}),
    ...(entry.conventions === undefined ? {} : { conventions: conventionsOf(instance, entry) }) };
}

// The team's packages with the digest of the file, or null when it has none. A refusal names the file and the fix.
export function loadPackages({ instance, productRoot }) {
  const file = join(instance, PACKAGES), stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  need(stat.isFile(), `${PACKAGES} is not a regular file. ${FIX}`);
  const bytes = readFileSync(file);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { need(false, `${PACKAGES} is not valid (not JSON). ${FIX}`); }
  try {
    need(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).sort().join() === 'packages,schemaVersion' && parsed.schemaVersion === 1 && Array.isArray(parsed.packages),
      'it must hold exactly schemaVersion 1 and packages, a list');
    const packages = parsed.packages.map(entry => checkPackage(instance, productRoot, entry));
    const names = packages.map(entry => entry.name.toLowerCase()), twice = packages.find((entry, i) => names.indexOf(names[i]) !== i);
    need(!twice, `the name ${twice?.name} is used twice`);
    for (const [i, a] of packages.entries()) for (const b of packages.slice(i + 1)) need(!overlap(`${a.dir}/**`, `${b.dir}/**`), `the folders of ${a.name} and ${b.name} contain one another`);
    return { digest: bytesDigest(bytes), packages };
  } catch (error) { if (isPackagesError(error)) need(false, `${PACKAGES} is not valid: ${error.message}. ${FIX}`); throw error; }
}

// The batch's tickets as they run: a ticket of a package is checked against it and, with no commands of its own, verifies with the package's.
export function packagedTickets(batch, team) {
  const written = ticket => [...ticket.paths, ...(ticket.moves ?? []).flatMap(move => [move.from, move.to]), ...(ticket.deletes ?? [])];
  return batch.tickets.map(ticket => {
    // A ticket that stays inside one package names it: left out, it would run without that package's conventions.
    const home = ticket.package === undefined && team?.packages.find(entry => written(ticket).every(path => path.startsWith(`${entry.dir}/`)));
    need(!home, `Ticket ${ticket.id} writes only inside the folder of package ${home?.name} (${home?.dir}/) and does not name it: add "package": "${home?.name}", so that it runs with that package's conventions and commands`);
    if (ticket.package === undefined) return ticket;
    need(team, `Ticket ${ticket.id} names package ${ticket.package}, but the team has no packages file (${PACKAGES}). Write it, or leave the field out`);
    const own = team.packages.find(entry => entry.name.toLowerCase() === ticket.package.toLowerCase());
    need(own, `Ticket ${ticket.id} names package ${ticket.package}, which ${PACKAGES} does not list (known: ${team.packages.map(entry => entry.name).join(', ') || 'none'})`);
    const outside = written(ticket).find(path => !path.startsWith(`${own.dir}/`));
    need(outside === undefined, `Ticket ${ticket.id} writes ${outside}, outside the folder of its package ${own.name} (${own.dir}/): ${SHARED}`);
    if (ticket.verificationCommands || !own.verificationCommands) return ticket;
    const unlisted = own.verificationCommands.find(command => !batch.verificationCommands.includes(command));
    need(unlisted === undefined, `Ticket ${ticket.id}: package ${own.name} verifies with ${unlisted}, which is not one of the batch's verificationCommands; add it to the batch's, or give the ticket its own verificationCommands`);
    return { ...ticket, verificationCommands: own.verificationCommands };
  });
}
export const packageOf = (team, ticket) => ticket.package === undefined ? null : team.packages.find(entry => entry.name.toLowerCase() === ticket.package.toLowerCase());

// ADR 0010, amendment of 2026-11-27: each path a ticket changed that another package reads, by the packages the batch froze.
export const interfaceChanges = (frozen, tickets) => tickets.flatMap(ticket => ticket.changedPaths.flatMap(path => {
  const readBy = frozen.filter(entry => entry.name !== ticket.package && entry.interfaces.some(pattern => globOf(pattern).test(path))).map(entry => entry.name);
  return readBy.length ? [{ ticket: ticket.id, path, readBy }] : [];
}));
