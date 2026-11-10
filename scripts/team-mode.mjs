import { readFileSync, statSync } from 'node:fs';
import { parseJSON } from '../src/loop/contracts.mjs';
import { draftTeam, writeDraft, verifyDraft } from '../src/router-worker/draft.mjs';

const [command, specPath, outputPath, ...extra] = process.argv.slice(2);
if (!['preview', 'draft', 'verify'].includes(command) || !specPath || extra.length || (command === 'preview' ? outputPath !== undefined : !outputPath)) {
  console.error('usage: node scripts/team-mode.mjs preview <spec.json> | draft <spec.json> <new-file.rw-draft.json> | verify <spec.json> <draft.json> (never activates a team)');
  process.exitCode = 1;
} else {
  try {
    const stat = statSync(specPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Expected a bounded spec file');
    const spec = parseJSON(readFileSync(specPath, 'utf8'));
    if (command === 'verify') {
      const artifactStat = statSync(outputPath);
      if (!artifactStat.isFile() || artifactStat.size > 4 * 1024 * 1024) throw Error('Expected a bounded draft artifact');
    }
    const result = command === 'verify'
      ? verifyDraft(spec, parseJSON(readFileSync(outputPath, 'utf8'), 4 * 1024 * 1024)) : draftTeam(spec);
    if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
    else process.stdout.write(JSON.stringify(command === 'draft' ? writeDraft(result.draft, outputPath) : result, null, 2) + '\n');
  } catch {
    console.error(JSON.stringify({ errors: [{ code: 'TEAM_DRAFT_FAILED', field: 'draft', reason: 'Cannot read spec or publish a new inert draft; existing artifacts are never overwritten' }] }));
    process.exitCode = 2;
  }
}
