import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 8793;
const origin = `http://127.0.0.1:${port}`;
const wsOrigin = `ws://127.0.0.1:${port}`;
const persistDir = await mkdtemp(join(tmpdir(), 'candy-finder-do-'));
let workerProcess;
const clients = new Set();

function runBuild() {
  const result = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Build failed with exit status ${result.status ?? 'unknown'}.`);
}

function startWorker() {
  workerProcess = spawn(process.execPath, [join(root, 'scripts', 'dev-worker.mjs'), '--port', String(port), '--persist-to', persistDir], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  workerProcess.stdout.on('data', (chunk) => process.stdout.write(chunk));
  workerProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));
  workerProcess.on('exit', (code, signal) => {
    if (code !== null && code !== 0 && !signal) console.error(`Local Wrangler exited with ${code}.`);
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    if (workerProcess?.exitCode !== null && workerProcess?.exitCode !== undefined) {
      throw new Error(`Local Wrangler stopped before becoming ready (exit ${workerProcess.exitCode}).`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error(`Timed out waiting for local Worker health${lastError ? `: ${lastError}` : ''}.`);
}

async function mint(name, cookie) {
  const headers = { 'content-type': 'application/json', origin };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${origin}/api/auth/token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ displayName: name }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `token issue failed: ${JSON.stringify(body)}`);
  const setCookie = response.headers.get('set-cookie');
  const cookieValue = cookie ?? (setCookie ? setCookie.split(';', 1)[0] : null);
  return { ...body, cookie: cookieValue, setCookie };
}

function createSocket(credentials, channel = 'duels') {
  const socket = new WebSocket(`${wsOrigin}/ws?channel=${channel}`, ['candy.v1', `auth.${credentials.token}`]);
  clients.add(socket);
  const inbox = [];
  const waiters = [];
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    inbox.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(message)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    }
  });
  const waitFor = (predicate, timeoutMs = 5000) => {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolveWait, reject) => {
      const waiter = { predicate, resolve: resolveWait, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error('Timed out waiting for WebSocket message.'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const opened = new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error('WebSocket connection timed out.')), 8000);
    socket.once('open', () => { clearTimeout(timeout); resolveOpen(); });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      rejectOpen(new Error(`WebSocket rejected with HTTP ${response.statusCode}.`));
    });
    socket.once('error', (error) => { clearTimeout(timeout); rejectOpen(error); });
  });
  const snapshot = waitFor((message) => message.type === 'snapshot', 8000);
  return { socket, waitFor, opened, snapshot };
}

async function connect(credentials, channel) {
  const client = createSocket(credentials, channel);
  await client.opened;
  const snapshot = await client.snapshot;
  assert.equal(client.socket.protocol, 'candy.v1', 'server should negotiate only the public application protocol');
  return { ...client, initialSnapshot: snapshot };
}

async function expectUnauthorizedSocket(protocols) {
  const socket = new WebSocket(`${wsOrigin}/ws?channel=duels`, protocols);
  clients.add(socket);
  const code = await new Promise((resolveCode, rejectCode) => {
    const timeout = setTimeout(() => rejectCode(new Error('Unauthorized WebSocket request did not receive an HTTP rejection.')), 7000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      const status = response.statusCode;
      response.resume();
      resolveCode(status);
    });
    socket.once('open', () => { clearTimeout(timeout); rejectCode(new Error('Unauthenticated WebSocket connection unexpectedly opened.')); });
    socket.once('error', () => { /* HTTP upgrade rejection is reported via unexpected-response */ });
  });
  assert.equal(code, 401);
}

async function closeClient(client) {
  if (!client || client.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(client.socket, 'close').catch(() => []);
  client.socket.close(1000, 'integration test cleanup');
  await Promise.race([closed, new Promise((resolveClose) => setTimeout(resolveClose, 1500))]);
  clients.delete(client.socket);
}

function section(name) { console.log(`\n[integration] ${name}`); }

try {
  runBuild();
  startWorker();
  await waitForHealth();

  section('website, route manifest and health endpoint');
  const [page, health, routeManifest] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/api/health`),
    fetch(`${origin}/manus-routes.json`),
  ]);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /CANDY FINDER/);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'CANDY FINDER');
  assert.deepEqual((await routeManifest.json()).routes, [{ path: '/', title: 'CANDY FINDER' }]);
  console.log('PASS: homepage, route manifest and backend health respond.');

  section('socket handshake authentication');
  await expectUnauthorizedSocket(['candy.v1']);
  await expectUnauthorizedSocket(['candy.v1', 'auth.not-a-valid-token']);
  const invalidName = await fetch(`${origin}/api/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ displayName: '<script>' }),
  });
  assert.equal(invalidName.status, 400);
  const oversizedBody = await fetch(`${origin}/api/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3072).fill(0x61)); controller.close(); } }),
    duplex: 'half',
  });
  assert.equal(oversizedBody.status, 413);
  console.log('PASS: no-token, malformed-token, invalid-name and oversized requests are rejected.');

  section('multi-user DUELS sync, duplicate prevention, and owner-only removal');
  const playerA = await mint('PixelPilot');
  assert.match(playerA.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(playerA.setCookie ?? '', /HttpOnly/);
  assert.match(playerA.setCookie ?? '', /Secure/);
  assert.match(playerA.setCookie ?? '', /SameSite=None/);
  const playerB = await mint('BlueNova');
  const a = await connect(playerA, 'duels');
  const baselineOnlineCount = a.initialSnapshot.onlineUserCount;
  const baselineActiveCount = a.initialSnapshot.activeListingCount;
  assert.ok(baselineOnlineCount >= 1);
  const b = await connect(playerB, 'duels');
  assert.equal(b.initialSnapshot.onlineUserCount, baselineOnlineCount + 1);
  await a.waitFor((message) => message.type === 'presence' && message.onlineUserCount === baselineOnlineCount + 1);

  const offer = { type: 'listing:create', itemName: 'Glacier Dragon', lookingFor: '1v1, any level', details: 'Friendly match', expiresInMinutes: 15 };
  a.socket.send(JSON.stringify(offer));
  const [aCreated, bCreated] = await Promise.all([
    a.waitFor((message) => message.type === 'listing:created' && message.listing.ownerId === playerA.subject),
    b.waitFor((message) => message.type === 'listing:created' && message.listing.ownerId === playerA.subject),
  ]);
  const listingId = aCreated.listing.id;
  assert.equal(aCreated.activeListingCount, baselineActiveCount + 1);
  assert.equal(bCreated.listing.itemName, 'Glacier Dragon');

  a.socket.send(JSON.stringify(offer));
  assert.equal((await a.waitFor((message) => message.type === 'error')).code, 'DUPLICATE_LISTING');
  b.socket.send(JSON.stringify({ type: 'listing:remove', listingId }));
  assert.equal((await b.waitFor((message) => message.type === 'error')).code, 'NOT_LISTING_OWNER');
  a.socket.send(JSON.stringify({ type: 'listing:remove', listingId }));
  const [aRemoved, bRemoved] = await Promise.all([
    a.waitFor((message) => message.type === 'listing:removed' && message.listingId === listingId),
    b.waitFor((message) => message.type === 'listing:removed' && message.listingId === listingId),
  ]);
  assert.equal(aRemoved.activeListingCount, baselineActiveCount);
  assert.equal(bRemoved.activeListingCount, baselineActiveCount);
  console.log('PASS: simultaneous clients saw live creation and removal; duplicates and unauthorized removal were rejected.');

  const persistentOffer = { type: 'listing:create', itemName: 'Echo Lynx', lookingFor: 'Friendly spar', details: 'Ready to play', expiresInMinutes: 15 };
  a.socket.send(JSON.stringify(persistentOffer));
  const [aPersisted, bPersisted] = await Promise.all([
    a.waitFor((message) => message.type === 'listing:created' && message.listing.itemName === 'Echo Lynx'),
    b.waitFor((message) => message.type === 'listing:created' && message.listing.itemName === 'Echo Lynx'),
  ]);
  assert.equal(aPersisted.activeListingCount, baselineActiveCount + 1);
  assert.equal(bPersisted.activeListingCount, baselineActiveCount + 1);
  const persistentListingId = aPersisted.listing.id;

  await closeClient(b);
  await closeClient(a);
  section('reconnect and persistent listing storage');
  const resumed = await mint('PixelPilot', playerA.cookie);
  assert.equal(resumed.subject, playerA.subject, 'the signed HttpOnly session should preserve the anonymous player identity');
  const a2 = await connect(resumed, 'duels');
  assert.ok(a2.initialSnapshot.onlineUserCount >= 1, 'the reconnected client should be counted as online');
  assert.ok(a2.initialSnapshot.listings.some((listing) => listing.id === persistentListingId), 'the listing should survive the disconnect');
  a2.socket.send(JSON.stringify({ type: 'listing:remove', listingId: persistentListingId }));
  const removed = await a2.waitFor((message) => message.type === 'listing:removed' && message.listingId === persistentListingId);
  assert.equal(removed.activeListingCount, baselineActiveCount);
  console.log('PASS: reconnect retained the same identity and the Durable Object restored persistent state.');

  section('TRADES isolation and live persistence');
  const tradeConnection = await connect(await mint('TradePilot', playerA.cookie), 'trades');
  assert.equal(tradeConnection.initialSnapshot.channel, 'trades');
  assert.ok(!tradeConnection.initialSnapshot.listings.some((listing) => listing.id === persistentListingId), 'DUELS listings do not leak into TRADES');
  tradeConnection.socket.send(JSON.stringify({ type: 'listing:create', itemName: 'Candy Core', lookingFor: 'Blue Star', details: '', expiresInMinutes: 15 }));
  const tradeCreated = await tradeConnection.waitFor((message) => message.type === 'listing:created');
  assert.equal(tradeCreated.listing.channel, 'trades');
  const tradeListingId = tradeCreated.listing.id;
  await closeClient(tradeConnection);
  const tradeReconnect = await connect(await mint('TradePilot', playerA.cookie), 'trades');
  assert.ok(tradeReconnect.initialSnapshot.listings.some((listing) => listing.id === tradeListingId), 'the TRADES listing should survive reconnect');
  console.log('PASS: channels are isolated, and TRADES listings persist across disconnects.');

  await closeClient(a2);
  await closeClient(tradeReconnect);
  section('integration result');
  console.log('PASS: all local Worker, Durable Object, WebSocket and static website checks completed.');
} catch (error) {
  console.error('\n[integration] FAIL:', error);
  process.exitCode = 1;
} finally {
  for (const socket of clients) {
    try { socket.terminate(); } catch { /* already shut down */ }
  }
  if (workerProcess && workerProcess.exitCode === null) {
    workerProcess.kill('SIGTERM');
    await Promise.race([once(workerProcess, 'exit'), new Promise((resolveExit) => setTimeout(resolveExit, 3000))]);
  }
  await rm(persistDir, { recursive: true, force: true });
}
