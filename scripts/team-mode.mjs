import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJSON } from '../src/loop/contracts.mjs';
import { draftTeam, writeDraft, verifyDraft } from '../src/router-worker/draft.mjs';
import { stageTeam } from '../src/router-worker/stage.mjs';

const argv = process.argv.slice(2), flag = argv.indexOf('--instance');
const instance = flag === -1 ? [] : argv.splice(flag, 2).slice(1);
const [command, specPath, outputPath, ...rest] = argv;
const [stagingPath, ...extra] = command === 'stage' ? rest : [undefined, ...rest];
if (!['preview', 'draft', 'verify', 'stage'].includes(command) || !specPath || extra.length || (flag !== -1 && !instance[0])
  || (command === 'preview' ? outputPath !== undefined : !outputPath) || (command === 'stage' && (!stagingPath || !instance[0]))) {
  console.error('usage: node scripts/team-mode.mjs preview <spec.json> | draft <spec.json> <new-file.rw-draft.json> | verify <spec.json> <draft.json> [--instance <instance-root>] | stage <spec.json> <draft.json> <new-dir.rw-staging> --instance <instance-root> (never activates a team)');
  process.exitCode = 1;
} else {
  try {
    const options = instance[0] ? { instanceRoot: resolve(instance[0]) } : {};
    const stat = statSync(specPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Expected a bounded spec file');
    const spec = parseJSON(readFileSync(specPath, 'utf8'));
    if (command === 'verify' || command === 'stage') {
      const artifactStat = statSync(outputPath);
      if (!artifactStat.isFile() || artifactStat.size > 4 * 1024 * 1024) throw Error('Expected a bounded draft artifact');
    }
    const result = command === 'stage'
      ? stageTeam(spec, parseJSON(readFileSync(outputPath, 'utf8'), 4 * 1024 * 1024), resolve(stagingPath), options)
      : command === 'verify'
      ? verifyDraft(spec, parseJSON(readFileSync(outputPath, 'utf8'), 4 * 1024 * 1024), options) : draftTeam(spec, options);
    if (result.errors) { console.error(JSON.stringify(result)); process.exitCode = 2; }
    else {
      process.stdout.write(JSON.stringify(command === 'draft' ? writeDraft(result.draft, outputPath) : result, null, 2) + '\n');
      if (result.stage === 'staged-validation-failed') process.exitCode = 2;
    }
  } catch {
    console.error(JSON.stringify({ errors: [{ code: 'TEAM_DRAFT_FAILED', field: 'draft', reason: 'Cannot read spec or publish a new inert draft; existing artifacts are never overwritten' }] }));
    process.exitCode = 2;
  }
}
