import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const devVars = join(root, '.dev.vars');
if (!existsSync(devVars)) {
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(devVars, `WS_TOKEN_SECRET="${secret}"\n`, { mode: 0o600, flag: 'wx' });
  console.log('Created a random, ignored .dev.vars for local Worker authentication.');
} else {
  const contents = readFileSync(devVars, 'utf8');
  const secretLine = contents.split(/\r?\n/).find((line) => /^\s*WS_TOKEN_SECRET\s*=/.test(line));
  const secret = secretLine?.slice(secretLine.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
  if (new TextEncoder().encode(secret).byteLength < 32) {
    console.error('Local WS_TOKEN_SECRET is missing or shorter than 32 bytes. Edit the ignored .dev.vars before starting Wrangler.');
    process.exit(1);
  }
}

const wranglerEntrypoint = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const args = process.argv.slice(2);
if (!args.includes('--port')) args.push('--port', '8787');
const child = spawn(process.execPath, [wranglerEntrypoint, 'dev', '--local', ...args], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

let shuttingDown = false;
const forwardSignal = (signal) => {
  shuttingDown = true;
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
child.on('error', (error) => {
  console.error('Could not start Wrangler:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (shuttingDown) process.exitCode = 0;
  else if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
