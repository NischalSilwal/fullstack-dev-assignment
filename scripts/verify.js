/**
 * End-to-end verification script.
 * Run after starting the server: node scripts/verify.js
 *
 * Tests:
 *  1. Create a secret and retrieve it once (must succeed)
 *  2. Retrieve it again (must 404 — burn worked)
 *  3. Create a secret with short TTL, wait, attempt retrieve (must 404 — expiry worked)
 *  4. Invalid / non-existent ID returns 404
 *  5. Missing X-Burn-Token header returns 403 (bot protection)
 */

const BASE = process.env.API_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;

function ok(label)   { console.log(`  ✓  ${label}`); passed++; }
function fail(label, detail) { console.error(`  ✗  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }

async function post(path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function postRaw(path, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return { status: res.status, body: await res.json() };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Test helpers ────────────────────────────────────────────────────────────

async function createSecret(secret, ttl = 3600) {
  const { status, body } = await post('/api/secrets', { secret, ttl });
  if (status !== 201 || !body.id) throw new Error(`Create failed: ${JSON.stringify(body)}`);
  return body.id;
}

async function revealSecret(id) {
  // Uses POST with X-Burn-Token header (bot-protection endpoint)
  return postRaw(`/api/secrets/${id}/burn`, { 'X-Burn-Token': 'confirm' });
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testHealthCheck() {
  console.log('\n── Health check');
  const { status } = await get('/health');
  status === 200 ? ok('Server is reachable') : fail('Server not reachable', `status ${status}`);
}

async function testCreateAndRevealOnce() {
  console.log('\n── Test 1: Create and reveal once');
  const id = await createSecret('super-secret-password');
  ok('Secret created');

  const { status, body } = await revealSecret(id);
  if (status === 200 && body.secret === 'super-secret-password') {
    ok('Secret retrieved correctly on first access');
  } else {
    fail('First retrieval failed', `status=${status} body=${JSON.stringify(body)}`);
  }
}

async function testBurnOnView() {
  console.log('\n── Test 2: Secret burns after first view');
  const id = await createSecret('burn-me');

  await revealSecret(id); // first view — burns it

  const { status } = await revealSecret(id); // second view — must 404
  status === 404
    ? ok('Second access correctly returned 404')
    : fail('Secret was accessible twice — burn not working', `got status ${status}`);
}

async function testExpiry() {
  console.log('\n── Test 3: Secret expires after TTL (using 4s TTL — wait 5s)');
  const id = await createSecret('expires-soon', 4);
  ok('Secret created with 4s TTL');

  process.stdout.write('  … waiting 5 seconds');
  for (let i = 0; i < 5; i++) { await sleep(1000); process.stdout.write('.'); }
  console.log();

  const { status } = await revealSecret(id);
  status === 404
    ? ok('Expired secret correctly returned 404')
    : fail('Expired secret was still accessible', `got status ${status}`);
}

async function testInvalidId() {
  console.log('\n── Test 4: Invalid / non-existent ID returns 404');
  const { status } = await revealSecret('00000000-0000-4000-8000-000000000000');
  status === 404
    ? ok('Non-existent ID returned 404')
    : fail('Expected 404 for non-existent ID', `got status ${status}`);
}

async function testBotProtection() {
  console.log('\n── Test 5: Missing X-Burn-Token header returns 403 (bot protection)');
  const id = await createSecret('bot-test-secret');

  // Attempt reveal WITHOUT the X-Burn-Token header
  const { status } = await postRaw(`/api/secrets/${id}/burn`, {});
  status === 403
    ? ok('Request without burn token correctly returned 403')
    : fail('Expected 403 for missing burn token', `got status ${status}`);

  // Clean up: reveal properly so the secret is burned
  await revealSecret(id);
}

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nVerifying against ${BASE}`);
  try {
    await testHealthCheck();
    await testCreateAndRevealOnce();
    await testBurnOnView();
    await testExpiry();
    await testInvalidId();
    await testBotProtection();
  } catch (err) {
    console.error('\nUnexpected error:', err.message);
    failed++;
  }

  console.log(`\n── Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Some tests failed. Review the output above.\n');
    process.exit(1);
  } else {
    console.log('All tests passed.\n');
  }
})();
