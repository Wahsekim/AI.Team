import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// ADR 0011, decision 13: a reviewer's Reads of a flagged file evidence it when together they cover each of its lines. A file's
// kind, which says how the Read tool takes it, is decided here for the brief, the Read requirement and the coverage check alike.
// Claude Code's Read tool returns at most READ_LINES lines when given no limit.
export const READ_LINES = 2000;
// One ranged Read is sized to about this many bytes: well under the tool's output cap of about 25,000 tokens.
export const RANGE_BYTES = 60 * 1024;
export const READ_RULE = `Your Reads of a file must together cover every line of it: a Read covers ${READ_LINES} lines from its offset (from line 1 when it has none), or as many as its limit says, and a Read whose result is an error covers nothing; one Read covers an image, a PDF (pages given or not) or a notebook`;
// The tool reads these by their extension, whatever their bytes hold.
const MEDIA = /\.(png|jpe?g|gif|webp|pdf|ipynb)$/i;
// A NUL in the first bytes marks a file that is not text, as Git judges it.
const PROBE = 8000;

// The lines the Read tool numbers in a file: one per newline, one more for text after the last; an empty file has one.
export const linesOf = bytes => { let count = 0; for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) count++; return Math.max(1, count + (bytes.length && bytes[bytes.length - 1] !== 10 ? 1 : 0)); };
// The first and last line one Read returns; the tool reads offset 0 as line 1. A malformed range covers nothing.
export const rangeOf = ({ offset = 1, limit = READ_LINES }) => Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 ? [Math.max(1, offset), Math.max(1, offset) + limit - 1] : null;
// The first of lines 1 to `total` that no range covers, or null.
export const uncovered = (ranges, total) => { let next = 1; for (const [first, last] of [...ranges].sort((a, b) => a[0] - b[0])) { if (first > next) break; next = Math.max(next, last + 1); } return next > total ? null : next; };
// The given paths that are symbolic links, with their targets: a link's change is its target, not a file to read.
export const linksOf = (product, paths) => Object.fromEntries(paths.filter(path => lstatSync(join(product, path), { throwIfNoEntry: false })?.isSymbolicLink()).map(path => [path, readlinkSync(join(product, path))]));

// A flagged path of a brief (its `content` digests and `links`) as the Read tool takes it: a link or a deleted path is not
// opened, a binary file cannot be, media is read once, and each line of text is read, in ranges of `limit` lines when one Read
// would be too long.
export function readingOf(product, { content, links = {} }, path) {
  const absolute = join(product, path);
  if (Object.hasOwn(links, path)) return { path, absolute, kind: 'link', target: links[path] };
  if (content[path] === null) return { path, absolute, kind: 'deleted' };
  if (MEDIA.test(path)) return { path, absolute, kind: 'media' };
  const bytes = readFileSync(absolute);
  if (bytes.subarray(0, PROBE).includes(0)) return { path, absolute, kind: 'binary' };
  const lines = linesOf(bytes), long = lines > READ_LINES || bytes.length > RANGE_BYTES;
  return { path, absolute, kind: 'text', lines, size: bytes.length, limit: long ? Math.max(1, Math.min(READ_LINES, Math.floor(lines * RANGE_BYTES / bytes.length))) : null };
}
