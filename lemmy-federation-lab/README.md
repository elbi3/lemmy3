# Federation lab: a miniature Lemmy-style federation on Cloudflare

Two tiny "instances" (Bridge Cinema for the rats, PNW Gourmet Frogs) that exchange signed comments over HTTP,
with a queue, retries, and a dashboard with an offline switch. It recreates the *federation delivery* pattern, not Lemmy's code.

| Lab piece | Real Lemmy equivalent |
|---|---|
| Worker (API + /inbox) | Lemmy API server |
| D1 | PostgreSQL |
| Cloudflare Queue + consumer | In-process federation queue |
| /inbox | ActivityPub inbox |
| Shared-secret HMAC | Public-key HTTP Signatures (simplified here) |

## Deploy (first pass, untested: check each step)
Needs Node and a Cloudflare account. From `instance/`:
1. `npm install` then `npx wrangler login`
2. `npx wrangler d1 create bridge-db` and `npx wrangler d1 create frogs-db`; paste each id into its `wrangler.*.toml`
3. `npx wrangler queues create bridge-delivery` and `npx wrangler queues create frogs-delivery`
4. `npx wrangler d1 execute bridge-db --remote --file=schema.sql` (and `frogs-db`)
5. `npm run deploy:bridge` and `npm run deploy:frogs`; note both workers.dev URLs
6. Put each URL in the *other* config's `PEER_URL`, then redeploy both
7. Set the same secret on both: `npx wrangler secret put FEDERATION_SECRET -c wrangler.bridge.toml` (and frogs)
8. In `dashboard/public/index.html`, replace YOUR-SUBDOMAIN, then from `dashboard/` run `npx wrangler deploy`

## Known risks
- Worker-to-Worker fetches on workers.dev can fail with error 1042. If deliveries log that, tell your assistant.
- The offline switch is unauthenticated: fine for a demo, not for production.
- Only "Create comment" activities exist; no follows, posts, or key exchange yet.
