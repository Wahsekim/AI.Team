// Disposable gate source: the child acknowledges its SIGTERM handler before the
// parent exposes readiness. Both processes self-expire if test cleanup fails.
export function survivingDescendantSource({ readyFile, overflow = false } = {}) {
  const child = `process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => process.exit(0), 5000);`;
  return `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', () => {
      ${readyFile ? `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');` : ''}
      ${overflow ? `process.stdout.write('x'.repeat(2048));` : ''}
    });
    setTimeout(() => process.exit(0), 5000);`;
}
