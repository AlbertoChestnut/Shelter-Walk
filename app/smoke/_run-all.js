// Runs every browser smoke (smoke/*.js except _-prefixed helpers and
// tutorial-shots.js), prints a summary table and exits non-zero if any fail.
//   npm run smoke:all                   all smokes, 2 at a time
//   npm run smoke:all -- cats daycation only these
//   SMOKE_JOBS=1 SMOKE_TZ=UTC npm run smoke:all
// Each smoke gets its own free port and temp DB (see _harness.js), so they can
// run side by side. A smoke that runs longer than 240 s is killed and fails.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIR = __dirname;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 240000;
const JOBS = Math.max(1, Number(process.env.SMOKE_JOBS) || 2);
const SKIP = new Set(['tutorial-shots.js']);

const only = process.argv.slice(2).map((a) => a.replace(/\.js$/, ''));
const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && !f.startsWith('_') && !SKIP.has(f)).sort();
const unknown = only.filter((o) => !all.includes(`${o}.js`));
if (unknown.length) { console.error(`Unknown smoke(s): ${unknown.join(', ')}`); process.exit(2); }
const files = only.length ? all.filter((f) => only.includes(f.replace(/\.js$/, ''))) : all;

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    // Own process group, so a timeout also kills its server and Chromium.
    const child = spawn(process.execPath, [path.join(DIR, file)], {
      cwd: path.join(DIR, '..'),
      // Pinned clock from the first line, before the smoke computes any dates.
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=./test/_clock.js`.trim() }, // relative: the path has a space stdio: ['ignore', 'pipe', 'pipe'], detached: true
    });
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* group already gone */ }
      const result = { file, ok: code === 0 && !timedOut, code, timedOut, seconds: (Date.now() - started) / 1000, out };
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${file}  (${result.seconds.toFixed(1)} s)${timedOut ? '  timed out' : ''}`);
      if (!result.ok) console.log(out.split('\n').map((l) => `    | ${l}`).join('\n'));
      resolve(result);
    });
  });
}

// The line that says what went wrong, rather than the last stack frame.
function errorLine(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(FAIL|Smoke test FAILED|\w*Error\b|AssertionError)/.test(l))
    || lines.find((l) => !/^at /.test(l) && !/^✓/.test(l) && !/^\^+$/.test(l))
    || lines.pop();
}

async function main() {
  console.log(`Running ${files.length} smoke(s), ${JOBS} at a time, timezone ${process.env.SMOKE_TZ || 'America/New_York'}\n`);
  const queue = [...files];
  const results = [];
  const worker = async () => { while (queue.length) results.push(await runOne(queue.shift())); };
  await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));
  results.sort((a, b) => a.file.localeCompare(b.file));

  const w = Math.max(...results.map((r) => r.file.length), 5);
  console.log(`\n${'Smoke'.padEnd(w)}  Result  Time    Note`);
  console.log(`${'-'.repeat(w)}  ------  ------  ----`);
  for (const r of results) {
    const lastLine = r.ok ? '' : (r.timedOut ? `timed out after ${TIMEOUT_MS / 1000} s` : errorLine(r.out) || `exit ${r.code}`).slice(0, 100);
    console.log(`${r.file.padEnd(w)}  ${r.ok ? 'pass  ' : 'FAIL  '}  ${`${r.seconds.toFixed(1)}s`.padEnd(6)}  ${lastLine}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
