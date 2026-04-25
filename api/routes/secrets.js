import express      from 'express';
import rateLimit    from 'express-rate-limit';
import { v4 as uuid } from 'uuid';
import { encrypt, decrypt } from '../utils/crypto.js';

const router = express.Router();

const MAX_TTL_SECONDS  = 604800; // 7 days max
const MAX_SECRET_BYTES = 10240;  // 10 KB limit
const BURN_TOKEN_VALUE = 'confirm';

// Stricter rate limits for secret creation vs retrieval
const createLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const retrieveLimiter = rateLimit({ windowMs:  5 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });

// Basic UUID v4 validation
function validUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

// POST /api/secrets — Create new secret
router.post('/', createLimiter, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { secret, ttl } = req.body;

    if (!secret || typeof secret !== 'string' || !secret.trim())
      return res.status(400).json({ error: 'secret is required.' });
    if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES)
      return res.status(413).json({ error: `Secret exceeds ${MAX_SECRET_BYTES} byte limit.` });

    const ttlSeconds    = Math.min(Math.max(parseInt(ttl, 10) || 3600, 1), MAX_TTL_SECONDS);
    const expiresAt     = new Date(Date.now() + ttlSeconds * 1000);
    const id            = uuid();
    const encryptedBody = encrypt(secret);

    await db.query(
      `INSERT INTO secrets (id, encrypted_body, expires_at) VALUES ($1, $2, $3)`,
      [id, encryptedBody, expiresAt.toISOString()],
    );

    const origin = process.env.FRONTEND_ORIGIN || `${req.protocol}://${req.get('host')}`;
    return res.status(201).json({
      id,
      link: `${origin}/${id}`,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) { next(err); }
});

// POST /api/secrets/:id/burn — Retrieve and delete secret
//
// Block crawlers: Slack/WhatsApp/GitHub previews only send GET requests.
// Requiring POST with a custom header ensures only real users trigger the burn.
//
// Prevent race conditions: Atomic DELETE ... RETURNING in Postgres ensures
// only the first request to hit the row succeeds, others get 0 rows back.
router.post('/:id/burn', retrieveLimiter, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    // Check for required header to block automated crawlers
    const burnToken = req.headers['x-burn-token'];
    if (burnToken !== BURN_TOKEN_VALUE) {
      return res.status(403).json({ error: 'Missing or invalid burn token.' });
    }

    if (!validUUID(id)) {
      return res.status(404).json({ error: 'Secret not found.' });
    }

    // Atomic delete: only return unexpired, unviewed secrets
    const { rows } = await db.query(
      `DELETE FROM secrets
       WHERE id = $1
         AND is_viewed = FALSE
         AND expires_at > NOW()
       RETURNING encrypted_body`,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Secret not found, already viewed, or expired.' });
    }

    const plaintext = decrypt(rows[0].encrypted_body);
    return res.status(200).json({ secret: plaintext });
  } catch (err) { next(err); }
});

export default router;
