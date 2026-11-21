import { readFileSync, statSync, writeSync, readSync, openSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseJSON } from '../src/loop/contracts.mjs';
import { draftTeam, writeDraft, verifyDraft } from '../src/router-worker/draft.mjs';
import { stageTeam } from '../src/router-worker/stage.mjs';

import { proposeSwitch, switchMode, recoverSwitch, proposeLimits, changeLimits } from '../src/router-worker/switch.mjs';
import { draftRequest } from '../src/router-worker/request.mjs';
import { proposeAcknowledge, acknowledgeEscalation } from '../src/router-worker/escalations.mjs';

// Written synchronously: process.exit would cut a pending pipe write short.
const finish = (result, done) => {
  if (result.errors) { writeSync(2, JSON.stringify(result) + '\n'); process.exit(2); }
  writeSync(1, JSON.stringify(result, null, 2) + '\n'); process.exit(done ? 0 : 2);
};
// A proposal is confirmed by a person: its code is typed at an interactive terminal. Anywhere else nothing changes.
function typedAtTerminal(proposal, what) {
  writeSync(1, JSON.stringify(proposal, null, 2) + '\n');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    writeSync(2, 'Nothing was changed. This is confirmed by a person: run this command in an interactive terminal and type the code it asks for.\n');
    process.exit(2);
  }
  const code = proposal.digest.slice(-8), typed = Buffer.alloc(256);
  writeSync(1, `\nType ${code} to ${what}; anything else cancels: `);
  let answer = '';
  // Node's own stdin does not block on a terminal; the terminal is opened for the one line.
  try { answer = typed.subarray(0, readSync(openSync('/dev/tty', 'r'), typed)).toString('utf8').trim(); } catch { /* no answer */ }
  if (answer !== code) { writeSync(2, 'Cancelled; nothing was changed.\n'); process.exit(2); }
}
const flags = (rest, allowed, bare = []) => {
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i], value = bare.includes(name) ? true : rest[++i];
    if (![...allowed, ...bare].includes(name) || Object.hasOwn(options, name) || !value || (value !== true && value.startsWith('--'))) return null;
    options[name] = value;
  }
  return options;
};

// request --instance <root> [--model <id>] [--ui]
//   Prints a REQUEST.json for the switch, drafted from profiles/project.md with the ADR's staffing and limits.
if (process.argv[2] === 'request') {
  const options = flags(process.argv.slice(3), ['--instance', '--model'], ['--ui']);
  if (!options?.['--instance']) { console.error('usage: node scripts/team-mode.mjs request --instance <instance-root> [--model <roster model id>] [--ui]'); process.exit(1); }
  const instanceRoot = resolve(options['--instance']);
  const drafted = draftRequest({ teamRoot: join(instanceRoot, 'kit'), instanceRoot, ...(options['--model'] ? { model: options['--model'] } : {}), ui: options['--ui'] === true });
  if (drafted.errors) finish(drafted, false);
  for (const note of drafted.notes) writeSync(2, `note: ${note}\n`);
  finish(drafted.request, true);
}

// limits <LIMITS.json> --instance <root>
//   Changes the limits of a live Router/Worker team; confirmed like a switch.
if (process.argv[2] === 'limits') {
  const [file, ...rest] = process.argv.slice(3), options = file ? flags(rest, ['--instance']) : null;
  if (!options?.['--instance']) { console.error('usage: node scripts/team-mode.mjs limits <LIMITS.json> --instance <instance-root>   (LIMITS.json: {"outputAllowancePerTicket"?: n, ...})'); process.exit(1); }
  const instanceRoot = resolve(options['--instance']), common = { teamRoot: join(instanceRoot, 'kit'), instanceRoot };
  let limits; try { limits = JSON.parse(readFileSync(file, 'utf8')); } catch { finish({ errors: [{ code: 'LIMITS_REFUSED', field: 'limits', reason: `${file} is not readable JSON` }] }, false); }
  const proposal = proposeLimits({ ...common, limits });
  if (proposal.errors) finish(proposal, false);
  typedAtTerminal(proposal, 'change the limits of this team');
  finish(changeLimits({ ...common, limits, confirm: proposal.digest, atTerminal: true }), true);
}

// acknowledge <escalation id> --instance <root>
//   The owner lifts an escalated ticket's block (ADR 0011, decisions 16 and 17); confirmed like a switch.
if (process.argv[2] === 'acknowledge') {
  const [id, ...rest] = process.argv.slice(3), options = id && !id.startsWith('--') ? flags(rest, ['--instance']) : null;
  if (!options?.['--instance']) { console.error('usage: node scripts/team-mode.mjs acknowledge <escalation id> --instance <instance-root>   (the open escalations are in reviews/escalations.jsonl)'); process.exit(1); }
  const instanceRoot = resolve(options['--instance']), common = { teamRoot: join(instanceRoot, 'kit'), instanceRoot, id };
  const proposal = proposeAcknowledge(common);
  if (proposal.errors) finish(proposal, false);
  typedAtTerminal(proposal, `lift escalation ${proposal.escalation.id}`);
  finish(acknowledgeEscalation({ ...common, confirm: proposal.digest, atTerminal: true }), true);
}

// switch <specialist|router-worker> <REQUEST.json> --instance <root> --product-root <product>
//   Prints the proposal. At an interactive terminal it then asks for the proposal's code and switches when it is
//   typed; anywhere else it changes nothing (exit 2). A session that runs commands without a terminal cannot confirm.
// switch recover --instance <root>
//   Rolls back a switch that was interrupted.
if (process.argv[2] === 'switch') {
  const [, to, ...tail] = process.argv.slice(2), recover = to === 'recover', [file, ...rest] = recover ? [null, ...tail] : tail, options = {};
  let wellFormed = rest.length % 2 === 0;
  for (let i = 0; i < rest.length; i += 2) { if (Object.hasOwn(options, rest[i]) || !rest[i + 1]) wellFormed = false; options[rest[i]] = rest[i + 1]; }
  const allowed = recover ? ['--instance'] : ['--instance', '--product-root'];
  if (!wellFormed || !Object.keys(options).every(key => allowed.includes(key)) || !options['--instance'] || (!recover && (!['specialist', 'router-worker'].includes(to) || !file || !options['--product-root']))) {
    console.error('usage: node scripts/team-mode.mjs switch <specialist|router-worker> <REQUEST.json> --instance <instance-root> --product-root <product-root>   (REQUEST.json; confirmed by typing a code at an interactive terminal: {"spec"?: {...}, "limits"?: {...}})\n'
      + '       node scripts/team-mode.mjs switch recover --instance <instance-root>   (rolls back an interrupted switch)');
    process.exit(1);
  }
  const instanceRoot = resolve(options['--instance']), teamRoot = join(instanceRoot, 'kit');
  if (recover) { const result = recoverSwitch({ teamRoot, instanceRoot }); finish(result, true); }
  let request;
  try { request = JSON.parse(readFileSync(file, 'utf8')); } catch { request = null; }
  const common = { to, request, teamRoot, instanceRoot, productRoot: resolve(options['--product-root']) };
  const result = request === null ? { errors: [{ code: 'SWITCH_REFUSED', field: 'switch', reason: 'REQUEST.json is not readable JSON' }] }
    : proposeSwitch(common);
  if (result.errors) finish(result, false);
  typedAtTerminal(result, `switch this team from ${result.from} to ${result.to}`);
  finish(switchMode({ ...common, confirm: result.digest, atTerminal: true }), true);
}

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
      if (command === 'stage' && result.stage !== 'staged-structurally-validated') process.exitCode = 2;
    }
  } catch {
    console.error(JSON.stringify({ errors: [{ code: 'TEAM_DRAFT_FAILED', field: 'draft', reason: 'Cannot read spec or publish a new inert draft; existing artifacts are never overwritten' }] }));
    process.exitCode = 2;
  }
}
