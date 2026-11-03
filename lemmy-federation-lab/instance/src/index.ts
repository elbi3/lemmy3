// One Worker, deployed twice (bridge + frogs). Each deployment is a tiny "instance":
// API + inbox (like Lemmy's API server), D1 (like Postgres), a Queue (like the federation queue).
export interface Env {
  DB: D1Database;
  DELIVERY: Queue<{ commentId: string }>;
  INSTANCE: string;
  HOME_COMMUNITY: string;
  PEER_URL: string;
  FEDERATION_SECRET: string;
  ADMIN_TOKEN: String;
  PEER?: Fetcher;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const MAX_RETRIES = 40; // keep in sync with max_retries in the wrangler configs
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...CORS } });

const authed = (req: Request, env: Env) =>
     !!env.ADMIN_TOKEN && req.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`;
// Simplified signing: HMAC with a shared secret. Real ActivityPub uses per-actor public-key HTTP Signatures.
async function sign(secret: string, data: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isOnline(env: Env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='online'").first<{ value: string }>();
  return row?.value !== '0';
}

const logDelivery = (env: Env, id: string, status: string, attempts: number, detail: string) =>
  env.DB.prepare('UPDATE deliveries SET status=?, attempts=?, detail=?, updated_at=? WHERE comment_id=?')
    .bind(status, attempts, detail, Date.now(), id).run();

async function createComment(req: Request, env: Env) {
  const { author, community, body } = (await req.json()) as Record<string, string>;
  if (!author || !community || !body) return json({ error: 'author, community and body are required' }, 400);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO comments(id,author,community,body,origin,created_at) VALUES(?,?,?,?,?,?)')
    .bind(id, author.slice(0, 40), community, body.slice(0, 500), env.INSTANCE, now).run();
  const federated = community !== env.HOME_COMMUNITY; // remote community -> must be delivered to its home instance
  if (federated) {
    await env.DB.prepare("INSERT INTO deliveries(comment_id,status,attempts,detail,updated_at) VALUES(?, 'queued', 0, 'waiting for delivery', ?)")
      .bind(id, now).run();
    await env.DELIVERY.send({ commentId: id });
  }
  return json({ id, federated }, 201);
}

async function inbox(req: Request, env: Env) {
  if (!(await isOnline(env))) return json({ error: 'instance offline' }, 503);
  const raw = await req.text();
  const ts = req.headers.get('x-fed-date') ?? '';
  const sig = req.headers.get('x-fed-signature') ?? '';
  const fresh = Math.abs(Date.now() - Number(ts)) < 5 * 60_000;
  if (!fresh || sig !== (await sign(env.FEDERATION_SECRET, `${ts}.${raw}`))) return json({ error: 'bad signature' }, 401);
  const a = JSON.parse(raw);
  if (a.type !== 'Create' || a.object?.community !== env.HOME_COMMUNITY) return json({ error: 'unsupported activity' }, 422);
  // INSERT OR IGNORE makes retries safe: the same activity id is stored once.
  await env.DB.prepare('INSERT OR IGNORE INTO comments(id,author,community,body,origin,created_at) VALUES(?,?,?,?,?,?)')
    .bind(a.id, a.actor, a.object.community, a.object.body, String(a.actor).split('@')[1] ?? 'unknown', a.object.published).run();
  return json({ ok: true });
}

async function state(env: Env) {
  const comments = await env.DB.prepare(
    'SELECT c.id,c.author,c.community,c.body,c.origin,c.created_at,d.status FROM comments c LEFT JOIN deliveries d ON d.comment_id=c.id ORDER BY c.created_at DESC LIMIT 30'
  ).all();
  const deliveries = await env.DB.prepare('SELECT * FROM deliveries ORDER BY updated_at DESC LIMIT 20').all();
  return json({ instance: env.INSTANCE, community: env.HOME_COMMUNITY, online: await isOnline(env), comments: comments.results, deliveries: deliveries.results });
}

async function deliver(msg: Message<{ commentId: string }>, env: Env) {
  const c = await env.DB.prepare('SELECT * FROM comments WHERE id=?').bind(msg.body.commentId).first<any>();
  if (!c) { console.log('deliver: comment missing, dropping', msg.body.commentId); return msg.ack(); }
  console.log('deliver: start', c.id.slice(0, 8), 'attempt', msg.attempts);
  const activity = JSON.stringify({
    type: 'Create', id: c.id, actor: `${c.author}@${env.INSTANCE}`,
    object: { community: c.community, body: c.body, published: c.created_at },
  });
  const ts = String(Date.now());
  try {
    const send = env.PEER ? env.PEER.fetch.bind(env.PEER) : fetch;
    const res = await send(`${env.PEER_URL}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fed-date': ts, 'x-fed-signature': await sign(env.FEDERATION_SECRET, `${ts}.${activity}`) },
      body: activity,
    });
    await res.body?.cancel();
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      if(permanent){
        await logDelivery(env, c.id, 'failed', msg.attempts,  `rejected by peer (${res.status}), not retrying`);
        return msg.ack();
      }
      throw new Error(`${env.PEER_URL}/inbox answered ${res.status}`)
    };
    await logDelivery(env, c.id, 'delivered', msg.attempts, 'accepted by peer');
    msg.ack();
  } catch (e) {
       console.log('deliver: failed', c.id.slice(0, 8), 'attempt', msg.attempts, String(e));
    if (msg.attempts > MAX_RETRIES) {
      await logDelivery(env, c.id, 'failed', msg.attempts, `gave up: ${e}`);
      return msg.ack();
    }
    await logDelivery(env, c.id, 'retrying', msg.attempts, String(e))
    msg.retry({ delaySeconds: 5 }); // spaced out so a demo doesn't burn the free queue quota
  }
}

async function route(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (pathname === '/api/state') return state(env);
    if (pathname === '/api/comments' && req.method === 'POST') return createComment(req, env);
    if (pathname === '/inbox' && req.method === 'POST') return inbox(req, env);
    if (pathname === '/api/online' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
      const { online } = (await req.json()) as { online: boolean };
      await env.DB.prepare("INSERT INTO settings(key,value) VALUES('online',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(online ? '1' : '0').run();
      return json({ online });
    }
    if (pathname === '/api/reset' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM comments'),
        env.DB.prepare('DELETE FROM deliveries'),
        env.DB.prepare("INSERT INTO settings(key,value) VALUES('online','1') ON CONFLICT(key) DO UPDATE SET value='1'"),
     ]);
     return json({ ok: true });
   }
    return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof SyntaxError) return json({error: 'invalid JSON'}, 400);
      console.error(e);
      return json({error: 'internal error' }, 500)
    }
  },
  async queue(batch: MessageBatch<{ commentId: string }>, env: Env) {
    for (const msg of batch.messages) await deliver(msg, env);
  },
};
