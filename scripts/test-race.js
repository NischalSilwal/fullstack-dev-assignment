/**
 * Race condition stress test.
 * Fires N simultaneous requests at the same secret ID.
 * Exactly one must succeed (200); all others must fail (404).
 *
 * Run: node scripts/test-race.js
 */

const BASE        = process.env.API_URL  || 'http://localhost:3000';
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '10', 10);

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function reveal(id) {
  // Uses POST with X-Burn-Token header (bot-protection endpoint)
  const res = await fetch(`${BASE}/api/secrets/${id}/burn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Burn-Token': 'confirm',
    },
  });
  return { status: res.status, body: await res.json() };
}

(async () => {
  console.log(`\nRace condition test — ${CONCURRENCY} concurrent requests to the same secret\n`);

  // Create one secret
  const { status, body } = await post('/api/secrets', { secret: 'race-condition-test', ttl: 60 });
  if (status !== 201) {
    console.error('Failed to create secret:', body);
    process.exit(1);
  }
  const { id } = body;
  console.log(`  Secret created: ${id}`);
  console.log(`  Firing ${CONCURRENCY} simultaneous requests…\n`);

  // Fire all requests at the same time
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => reveal(id))
  );

  const successes = results.filter(r => r.status === 200);
  const failures  = results.filter(r => r.status === 404);
  const other     = results.filter(r => r.status !== 200 && r.status !== 404);

  console.log(`  200 OK  (got secret): ${successes.length}`);
  console.log(`  404     (burned/gone): ${failures.length}`);
  if (other.length) console.log(`  Other status codes: ${other.map(r => r.status).join(', ')}`);

  console.log();

  if (successes.length === 1 && failures.length === CONCURRENCY - 1) {
    console.log('  ✓  PASS — exactly one request got the secret. Race condition handled correctly.\n');
  } else if (successes.length === 0) {
    console.error('  ✗  FAIL — no request got the secret (possible bug in retrieve logic).\n');
    process.exit(1);
  } else if (successes.length > 1) {
    console.error(`  ✗  FAIL — ${successes.length} requests got the secret. Race condition NOT handled.\n`);
    process.exit(1);
  } else {
    console.error(`  ✗  UNEXPECTED result. Review the output above.\n`);
    process.exit(1);
  }
})();
