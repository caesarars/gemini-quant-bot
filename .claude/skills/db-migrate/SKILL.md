---
name: db-migrate
description: Add or modify a Postgres schema change correctly. Use whenever the user asks to add a column, table, index, or default — schema changes here must land in TWO places (db/init.sql AND runMigrations() in server.ts), and forgetting one breaks the VPS on the next deploy.
---

# db-migrate

The bot's Postgres schema lives in two places. **You must update both**, or you will break either fresh deploys or the existing VPS:

1. **[db/init.sql](db/init.sql)** — bootstraps a brand-new database (used by `docker compose up` on a fresh volume). If you add a column here only, existing deployments won't get it.
2. **`runMigrations()` in [server.ts](server.ts) (around line 27)** — runs on every server start with `IF NOT EXISTS` guards, so existing databases pick up the change. If you add a column here only, fresh deploys won't have it in the base schema (it still works because the migration runs at startup, but the base schema drifts).

## Procedure

1. **Read both files first** so you don't duplicate or contradict an existing column:
   - [db/init.sql](db/init.sql) (whole file, it's ~75 lines)
   - [server.ts](server.ts) `runMigrations()` body
2. **Pick the right pattern** based on the change type:

### Adding a column
Add the column definition to the relevant `CREATE TABLE` in `db/init.sql` AND append an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` line to `runMigrations()`. Keep the type and default identical in both places.

```sql
-- db/init.sql (inside the CREATE TABLE)
my_new_col NUMERIC(5,2) DEFAULT 0

-- server.ts runMigrations()
await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS my_new_col NUMERIC(5,2) DEFAULT 0`);
```

### Adding a table
Add the full `CREATE TABLE IF NOT EXISTS` block to BOTH `db/init.sql` AND `runMigrations()`. Same for any indexes (`CREATE INDEX IF NOT EXISTS`). The `ohlcv` table is the existing example — it appears in both files.

### Adding an index
Use `CREATE INDEX IF NOT EXISTS` in both files (see `idx_ohlcv_symbol_ts` for the pattern).

### Changing a default on an existing column
`ADD COLUMN IF NOT EXISTS` is a no-op once the column exists, so a new default in `runMigrations()` won't apply to existing rows. If you need to backfill, add a separate `UPDATE bot_settings SET ... WHERE ...` after the ALTER — see how `atr_tp_mult` and `active_strategies` do it.

### Renaming or dropping a column
Risky on a live VPS. Stop and confirm with the user before proceeding — there is no rollback path and the VPS auto-deploys on push to master.

## Defaults that matter

- `bot_settings` is a single-row config table (`id = 'bot_config'`). The default value on the ALTER is what the existing row will get for the new column — pick it carefully because it becomes the live runtime value immediately after deploy.
- For `TEXT[]` defaults, use Postgres array literal syntax: `DEFAULT '{value1,value2}'`.

## Verify

1. `npm run lint` — catches typos in any TypeScript that reads the new column.
2. Optional: `docker compose down -v && docker compose up -d --build` locally to confirm a fresh deploy still boots and the migration is idempotent on restart.

## Don't

- Don't add migration files in a separate `migrations/` directory — this project doesn't use a migration framework, it uses inline `IF NOT EXISTS` calls.
- Don't put `DROP COLUMN` or destructive DDL in `runMigrations()` without explicit user approval — it runs on every server start, including the production VPS.
