import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bytesDigest, canonical, digest, fields, id, requireThat } from './contracts.mjs';

export function projectionContent(runId, effect) {
  id(runId); fields(effect, ['id', 'kind', 'payload'], 'Projection effect'); id(effect.id);
  requireThat(effect.kind === 'projection', 'INVALID_SPEC', 'Expected a projection effect');
  fields(effect.payload, ['outcome', 'reason', 'candidate', 'usage'], 'Projection payload');
  requireThat(['COMPLETED', 'STOPPED', 'FAILED'].includes(effect.payload.outcome), 'INVALID_SPEC', 'Invalid projection outcome');
  requireThat(Buffer.byteLength(canonical(effect.payload)) <= 64 * 1024, 'LIMIT_REACHED', 'Projection payload exceeds limit');
  return `# AI.Team simulation result\n\nThis is a simulation record, not evidence of a real product build.\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, simulation: true, runId, effectId: effect.id, ...effect.payload }, null, 2)}\n\`\`\`\n`;
}

// Single immutable output per effect. Atomic no-replace link, never append/overwrite.
// Safe to reapply after file write but before the database acknowledges the effect.
export function publishProjection({ directory, runId, effect }) {
  const body = projectionContent(runId, effect);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync(directory), fileName = `${runId}.${effect.id}.md`, target = join(root, fileName);
  const verify = () => {
    const stat = lstatSync(target);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size === Buffer.byteLength(body), 'PROJECTION_CONFLICT', 'Existing projection is not the expected regular file');
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { requireThat(readFileSync(fd, 'utf8') === body, 'PROJECTION_CONFLICT', 'Projection was edited; preserving existing content'); }
    finally { closeSync(fd); }
  };
  let temp = null;
  try {
    try { verify(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      temp = join(root, `.projection-${randomUUID()}.tmp`);
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temp, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      verify();
    }
    // Make the directory entry durable before acknowledging it in SQLite.
    const dir = openSync(root, constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return { runId, effectId: effect.id, fileName, payloadDigest: digest(effect.payload), fileDigest: bytesDigest(body) };
  } finally { if (temp) unlinkSync(temp); }
}
