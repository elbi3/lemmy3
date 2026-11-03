# Federation Lab: a miniature Lemmy-style federation on Cloudflare

Two tiny "instances" (🐀 **Bridge Cinema** for the rats, 🐸 **PNW Gourmet Frogs**) that exchange signed comments over HTTP, with a queue, retries, and a dashboard that can take either instance offline. It recreates the *federation delivery* pattern used by [Lemmy](https://join-lemmy.org/), not Lemmy's code.

- **Live demo:** [plant-kennel.me/lab](https://plant-kennel.me/lab/) 
- **Repository:** https://github.com/elbi3/lemmy3

---

## 1. Project description

### System analyzed: Lemmy

Lemmy is an open-source, federated link aggregator (think Reddit, but many independent servers that talk to each other over ActivityPub). A user on one server can comment in a community hosted on another server. The user's server does not write to the other server's database. It *delivers an activity* to the other server's inbox, and the receiving server decides whether to accept it.

I describe Lemmy's architecture as a **modular monolith with a few sidecar services** rather than microservices: a Rust backend (organized as a workspace of crates) serving the API and federation, a separate web UI, an image service (pict-rs), PostgreSQL, and a reverse proxy, usually deployed together with Docker Compose. Federation is **asynchronous and event-driven**: outgoing activities are queued and retried rather than sent inside the user's request.

### Prototype built

The lab rebuilds one subsystem, **federated comment delivery**, on Cloudflare's serverless stack:

```
 Browser (lab page)
      │  POST /api/comments  (community = the OTHER instance's)
      ▼
┌──────────────┐   1. save comment + "queued" delivery row (D1)
│  Worker A    │   2. enqueue delivery job (Queue)
│ (e.g. bridge)│
└──────┬───────┘
       │ Queue consumer (async, retries every 5s, up to 40 times)
       │ signs activity with HMAC, sends it via service binding
       ▼
┌──────────────┐   verify timestamp + signature, check instance is online,
│  Worker B    │   check the community is ours, INSERT OR IGNORE (idempotent)
│ (e.g. frogs) │   → 200 OK, or 503 / 401 / 422 which makes A retry or give up
└──────────────┘
```

| Lab piece | Real Lemmy equivalent |
|---|---|
| Worker (`/api/*`) | Lemmy API server |
| D1 (SQLite) | PostgreSQL |
| Cloudflare Queue + consumer | Federation send queue with retries |
| `/inbox` endpoint | ActivityPub inbox |
| Shared-secret HMAC + timestamp | Per-actor public-key HTTP Signatures (simplified here) |
| Offline switch (`/api/online`) | An instance being down or unreachable |
| Dashboard page | n/a (visualizer for the demo) |

The lab's own architectural style is **serverless and event-driven**: two stateless Workers, durable state in D1, and a queue between "accept the comment" and "deliver the comment". Delivery is *at-least-once*, so the inbox is idempotent (`INSERT OR IGNORE` on the activity id) and a retry never creates a duplicate.

### What it demonstrates

- A comment posted on one instance, addressed to a community on the other, is stored locally, queued, delivered, and shown on both.
- Taking an instance offline makes its inbox answer `503`. The sender keeps the message in the queue and retries. When the instance comes back, the comment arrives with no manual action.
- A bad signature is rejected with `401`, so a stranger cannot inject comments.

### Repository layout

```
lemmy-federation-lab/
├── instance/                  # the Worker, deployed twice (bridge + frogs)
│   ├── src/index.ts           # API, inbox, signing, queue consumer
│   ├── schema.sql             # comments, deliveries, settings
│   ├── wrangler.bridge.toml   # config for Bridge Cinema
│   ├── wrangler.frogs.toml    # config for Gourmet Frogs
│   └── test/smoke-test.sh     # end-to-end checks against the live Workers
└── dashboard/                 # original standalone dashboard (static page)
```

The version of the dashboard used in the demo is `lab.astro`, a page in my Astro site (`src/pages/lab.astro`). It talks to the deployed Workers' public URLs.

---

## 2. Setup and run instructions

**Requirements:** Node 18+, a free Cloudflare account, and `git`.

### Clone and install

```bash
git clone https://github.com/elbi3/lemmy3.git
cd lemmy3/lemmy-federation-lab/instance
npm install
npx wrangler login
```

`node_modules/` is not committed, so `npm install` is required.

### Create the Cloudflare resources

```bash
# one database and one queue per instance
npx wrangler d1 create bridge-db
npx wrangler d1 create frogs-db
npx wrangler queues create bridge-delivery
npx wrangler queues create frogs-delivery
```

Paste each `database_id` printed by `d1 create` into the matching `wrangler.bridge.toml` / `wrangler.frogs.toml`, then create the tables on **both** remote databases:

```bash
npx wrangler d1 execute bridge-db --remote --file=schema.sql
npx wrangler d1 execute frogs-db  --remote --file=schema.sql
```

### Configure

Edit the `[vars]` block in each config. `PEER_URL` must point at the *other* Worker's URL. The committed files use my `workers.dev` subdomain (`ellbi3`), so replace it with yours:

| Variable | bridge config | frogs config |
|---|---|---|
| `INSTANCE` | `bridge` | `frogs` |
| `HOME_COMMUNITY` | `bridge_cinema` | `gourmet_frogs` |
| `PEER_URL` | `https://gourmet-frogs.<you>.workers.dev` | `https://bridge-cinema.<you>.workers.dev` |

Each config also has a **service binding** (`[[services]]`, binding name `PEER`) to the other Worker. This is what makes Worker-to-Worker delivery reliable. Calling another Worker's public `workers.dev` URL from inside a Worker can fail with Cloudflare error 1042.

### Deploy

The two bindings point at each other, and a binding to a Worker that does not exist yet fails the deploy. On a fresh account:

1. Comment out the `[[services]]` block in both configs.
2. `npm run deploy:bridge` then `npm run deploy:frogs` (this creates both Workers).
3. Put the `[[services]]` blocks back and deploy both again.

### Secrets

Both Workers need **the same** `FEDERATION_SECRET`. `ADMIN_TOKEN` protects the offline and reset buttons, and it can be any value as long as it is the same one you type into the page.

```bash
SECRET=$(openssl rand -hex 24)
printf %s "$SECRET" | npx wrangler secret put FEDERATION_SECRET -c wrangler.bridge.toml
printf %s "$SECRET" | npx wrangler secret put FEDERATION_SECRET -c wrangler.frogs.toml

TOKEN=$(openssl rand -hex 12); echo "Admin token: $TOKEN"
printf %s "$TOKEN" | npx wrangler secret put ADMIN_TOKEN -c wrangler.bridge.toml
printf %s "$TOKEN" | npx wrangler secret put ADMIN_TOKEN -c wrangler.frogs.toml
```

Secrets are never stored in the repo. `npx wrangler secret list -c <config>` shows which names are set (not their values).

### Run the dashboard

In your Astro project, copy `lab.astro` to `src/pages/lab.astro`. Change the `BASE` URLs at the top of its script to your two Workers, then:

```bash
npm run dev      # open http://localhost:4321/lab
```

The Workers send `access-control-allow-origin: *`, so the page works from localhost or any deployed domain. To deploy it, push to the branch your host builds from.

### Try it without the page

```bash
curl -s -X POST https://bridge-cinema.<you>.workers.dev/api/comments \
  -d '{"author":"Test","community":"gourmet_frogs","body":"hello from the rats"}'

curl -s https://gourmet-frogs.<you>.workers.dev/api/state | python3 -m json.tool
```

Watch the live logs of either Worker with `npx wrangler tail bridge-cinema` or `npx wrangler tail gourmet-frogs`.

### Demo script

1. Send a 🐀→🐸 comment, then a 🐸→🐀 comment. Both columns update within about 5 seconds, and the sender's delivery log shows `delivered`.
2. Paste the admin token and click **Take offline** on 🐸.
3. Send a 🐀→🐸 comment. Bridge's log shows `retrying … answered 503`, and the comment is not on the frogs' side.
4. Click **Bring online**. The queued comment is delivered on the next retry.
5. Click **Reset demo** to clear both instances.

---

## 3. AI disclosure and prompt appendix

### Tools used

- **Claude (Anthropic)**: initial architectural breakdown and scaffold of the Workers and dashboard. 
- **Claude (Anthropic)**: debugging the deployment (one-way delivery), explaining the dashboard labels, Git and GitHub push problems, and drafting this README.

### Sample prompts

1. "I was thinking today we could analyze a real-world application to identify its architectural style and key components. I'd like to analyze Reddit. Can you help me generate an initial architectural breakdown and scaffold a working companion prototype?"
2. "I was reading back through your mentions, and actually Lemmy sounds very interesting! Let's commit to that. Can we start with these:

    Identify its primary architectural style (e.g., modular monolith, event-driven microservices, serverless, layered/tier-based).
    Map its core components (compute engines, databases, queues/brokers, caches, reverse proxies)."
3. "I only get messages one way between my two Workers. Here is the project, what could cause that?"
4. "Can you write me a README for it? The lab was originally written for this assignment."

### What I verified, corrected, or customized

| Area | What the AI gave me | What I verified or changed |
|---|---|---|
| Worker-to-Worker calls | First pass fetched the peer's public `workers.dev` URL | Known risk of error 1042. Added service bindings (`[[services]]`) and used them in `deliver()`. |
| Offline switch | Unauthenticated | Added `ADMIN_TOKEN`; `/api/online` and `/api/reset` now return `401` without it. |
| Deploy steps | README steps assumed a single pass | Documented the circular service-binding bootstrap and the extra secret. |
| One-way delivery | "Only works one direction" | Both Workers' secrets and both remote schemas were present, so I tested each direction with curl and `wrangler tail` and read the delivery log. Both directions work. |
| Dashboard labels | "Rat comments in frogs' community" was confusing | Relabeled the options and column headers with 🐀/🐸 and "FROM → TO". |
| Types | `ADMIN_TOKEN: String` in `Env` | Should be `string` (harmless at runtime). |
| Lemmy claims | AI summary of Lemmy's federation | `[TODO: list what you checked against the official Lemmy docs/source and anything you corrected]` |
| Repo hygiene | No `.gitignore` in the zip | `node_modules` (including a 134 MB `workerd` binary) was committed and GitHub rejected the push. Added `.gitignore` and rebuilt the history without it. |

---

## 4. QA checklist

Run through this before recording. Check each box only once you have seen it pass.

**1. Functional**
- [ ] Send 🐀→🐸 and 🐸→🐀 comments; each appears on both columns and the sender's log shows `delivered`.
- [ ] Empty author or body is blocked by the form; the API returns `400` for missing fields and for invalid JSON.
- [ ] A very long author/body is accepted and truncated (40 / 500 characters).
- [ ] Offline then online: the comment is delivered after the instance returns; the log shows `retrying … 503` in between.
- [ ] Wrong or missing admin token shows "needs the admin token" and changes nothing.
- [ ] An unsigned request to `/inbox` returns `401`.

**2. UI and responsive**
- [ ] 1920×1080 renders cleanly.
- [ ] Phone and tablet widths (DevTools): columns stack, no clipped text or horizontal scroll.
- [ ] Light and dark mode are both readable.

**3. Cross-browser and console**
- [ ] Chromium-based browser: works, console clean.
- [ ] Firefox or Safari: works, console clean.
- [ ] No 404s in the Network tab.

**4. Accessibility and performance**
- [ ] Form fields are reachable by Tab in a sensible order.
- [ ] Fields have accessible labels (`[TODO: placeholders alone are not labels; add `aria-label` or `<label>`s if missing]`).
- [ ] Page loads promptly and polling (every 5 s) does not freeze the UI.

---

## 5. Known limitations

- Only "create comment" activities exist. There are no follows, posts, votes, or key exchange.
- HMAC with a single shared secret stands in for per-actor public-key HTTP Signatures.
- `/api/comments` is open: anyone with the URL can post. There is no rate limiting or user accounts.
- After 40 failed attempts (about 3.5 minutes at 5 s per retry) a delivery is marked `failed` and is **not** retried again, even if the peer comes back.
- The offline flag is stored in D1, so it survives redeploys. Bring an instance back online before demoing.
- The page does not show an error if the browser-to-Worker `POST` itself fails. The delivery log is the useful signal.
- `test/smoke-test.sh` does not send the `ADMIN_TOKEN` header yet, so its offline checks will fail until it is updated.
- CORS is `*`, which is acceptable for a demo but not for production.
