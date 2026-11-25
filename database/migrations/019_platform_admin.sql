ALTER TABLE users
  ADD COLUMN IF NOT EXISTS platform_admin boolean NOT NULL DEFAULT false;
