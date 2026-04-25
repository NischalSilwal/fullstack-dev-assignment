CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS secrets (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  encrypted_body TEXT        NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  is_viewed      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secrets_expires_at ON secrets (expires_at);
CREATE INDEX IF NOT EXISTS idx_secrets_unviewed   ON secrets (id) WHERE is_viewed = FALSE;
