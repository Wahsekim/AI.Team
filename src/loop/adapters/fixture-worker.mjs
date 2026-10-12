// Intentionally tiny simulated agent. No model, product writes, tools or network.
const [scenario, delayText] = process.argv.slice(2);
const delay = Number(delayText);
if (!['pass', 'fail', 'partial', 'crash', 'hang'].includes(scenario) || !Number.isSafeInteger(delay) || delay < 0 || delay > 1000) process.exit(2);
// Bound orphan lifetime even when the test host is killed.
const guard = setTimeout(() => process.exit(3), 5000);
setTimeout(() => {
  if (scenario === 'hang') return;
  clearTimeout(guard);
  if (scenario === 'crash') process.exit(7);
  if (scenario === 'partial') { process.stdout.write('{"simulation":'); return; }
  process.stdout.write(JSON.stringify({ simulation: true, result: scenario, tokens: 0, costMicroUsd: 0 }));
}, delay);
