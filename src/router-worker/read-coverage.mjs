import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// ADR 0011, decision 13: a reviewer's Reads of a flagged file evidence it when together they cover each of its lines. A file's
// kind, which says how the Read tool takes it, is decided here for the brief, the Read requirement and the coverage check alike.
// Claude Code's Read tool returns at most READ_LINES lines when given no limit.
export const READ_LINES = 2000;
// One ranged Read is sized to about this many bytes: with the line numbers the tool adds, 60 KB of dense text reaches its output
// cap of about 25,000 tokens.
export const RANGE_BYTES = 40 * 1024;
// The tool reads a file over this many bytes only in ranges; a text file that large is judged from its diff, not read.
export const WHOLE_BYTES = 256 * 1024;
export const READ_RULE = `Your Reads of a file must together cover every line of it: a Read covers ${READ_LINES} lines from its offset (from line 1 when it has none), or as many as its limit says, and a Read whose result is an error covers nothing; one Read covers an image, a PDF (pages given or not) or a notebook`;
const json = bytes => { try { JSON.parse(bytes.toString('utf8')); return true; } catch { return false; } };
// The tool reads these by their extension and fails on bytes of another format, so a file is media only when its bytes match.
const MEDIA = [[/\.png$/i, head => head.startsWith('\x89PNG\r\n\x1a\n')], [/\.jpe?g$/i, head => head.startsWith('\xff\xd8\xff')], [/\.gif$/i, head => /^GIF8[79]a/.test(head)],
  [/\.webp$/i, head => head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP'], [/\.pdf$/i, head => head.startsWith('%PDF')], [/\.ipynb$/i, (head, bytes) => json(bytes)]];
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
// opened, a binary file or one misnamed as media cannot be, a text file too large is judged from its diff, media is read once,
// and each line of text is read, in ranges of `limit` lines when one Read would be too long.
export function readingOf(product, { content, links = {} }, path) {
  const absolute = join(product, path);
  if (Object.hasOwn(links, path)) return { path, absolute, kind: 'link', target: links[path] };
  if (content[path] === null) return { path, absolute, kind: 'deleted' };
  const bytes = readFileSync(absolute), media = MEDIA.find(([name]) => name.test(path));
  if (media) return { path, absolute, kind: media[1](bytes.subarray(0, 12).toString('latin1'), bytes) ? 'media' : 'misnamed' };
  if (bytes.subarray(0, PROBE).includes(0)) return { path, absolute, kind: 'binary' };
  if (bytes.length > WHOLE_BYTES) return { path, absolute, kind: 'large', size: bytes.length };
  const lines = linesOf(bytes), long = lines > READ_LINES || bytes.length > RANGE_BYTES;
  return { path, absolute, kind: 'text', lines, size: bytes.length, limit: long ? Math.max(1, Math.min(READ_LINES, Math.floor(lines * RANGE_BYTES / bytes.length))) : null };
}
