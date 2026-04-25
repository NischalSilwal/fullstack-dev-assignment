import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import secretsRouter from './routes/secrets.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;

// Validate required env vars on startup
if (!process.env.MASTER_KEY || process.env.MASTER_KEY.length !== 64) {
  console.error('ERROR: MASTER_KEY must be a 64-character hex string.');
  console.error('Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // inline script in index.html
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(cors({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'X-Burn-Token'] }));
app.use(express.json({ limit: '16kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

// Database connection
const db = new Pool({ connectionString: process.env.DATABASE_URL });
app.locals.db = db;

// Routes
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.use('/api/secrets', secretsRouter);

// Catch unmatched API routes
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found.' }));

// Serve static frontend and SPA fallback
app.use(express.static(path.join(__dirname, '..', 'web')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

// Error handlers
app.use((_, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error.' });
});

// Periodic cleanup for expired secrets that weren't viewed
async function cleanupExpired() {
  try {
    const result = await db.query('DELETE FROM secrets WHERE expires_at <= NOW()');
    if (result.rowCount > 0) {
      console.log(`Cleanup: removed ${result.rowCount} expired secret(s).`);
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

// Run cleanup on startup and every 10 minutes
cleanupExpired();
setInterval(cleanupExpired, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
