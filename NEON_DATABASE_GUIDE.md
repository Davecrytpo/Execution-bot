# Neon Database Guide

This project works directly with a normal Neon Postgres connection string.

## Recommendation

If you already have a Neon connection string, use it directly as `DATABASE_URL`.

Example format:

```env
DATABASE_URL=postgresql://user:password@ep-example.us-east-1.aws.neon.tech/neondb?sslmode=require
```

For this app, `npx neonctl@latest init database` is optional. It can help create or initialize a Neon project, but once you already have a valid Neon database and connection string, the app does not need `neonctl` at runtime.

## Required Settings

- Put your Neon connection string in `DATABASE_URL`
- Keep `sslmode=require` in the URL
- Leave `DATABASE_SSL` empty unless you intentionally want to override SSL handling

## Local Setup

1. Copy `.env.example` to `.env`
2. Set `DATABASE_URL` to your Neon connection string
3. Fill the remaining required env vars
4. Build and migrate

```bash
npm install
npm run build
npm run migrate
```

## Quick Validation

After migration succeeds:

1. Start the API
2. Call `/health`
3. Call `/api/admin/summary` with `x-api-key`

## Security Note

If you ever paste a live connection string into chat, screenshots, or logs, rotate the database password afterward. Treat the connection string like a secret.
