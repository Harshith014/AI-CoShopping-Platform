const fs = require('node:fs/promises');
const path = require('node:path');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Emitter } = require('@socket.io/redis-emitter');
const IORedis = require('ioredis');
const { randomUUID } = require('node:crypto');
const db = require('./db');
const { queue } = require('./queue');

const app = Fastify({ logger: true });
const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const configuredOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
// Set FRONTEND_ORIGIN to the Vercel site's origin(s) in Render. Leaving it
// unset preserves same-origin/local development behavior.
const corsOrigin = configuredOrigins.length ? configuredOrigins : true;
const io = new Server({ cors: { origin: corsOrigin, credentials: true } });
const adapterPub = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const adapterSub = adapterPub.duplicate();
io.adapter(createAdapter(adapterPub, adapterSub));
const emitter = new Emitter(redis);
const roomKey = id => `room:${id}`;
const broadcast = (id, event, data) => emitter.to(roomKey(id)).emit(event, data);

app.register(cors, { origin: corsOrigin, credentials: true });
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/api')) reply.header('cache-control', 'no-store');
});
async function membership(roomId, userId) {
  if (!roomId || !userId) return false;
  const result = await db.query('SELECT 1 FROM rooms WHERE id=$1 AND $2=ANY(members)', [roomId, userId]);
  return result.rowCount > 0;
}
async function snapshot(roomId) {
  const [room, products, items, offer, messages, latestOrder] = await Promise.all([
    db.query('SELECT id,name,members,cart_version FROM rooms WHERE id=$1', [roomId]),
    db.query('SELECT id,name,description,price_cents,stock FROM products ORDER BY id'),
    db.query(`SELECT p.id,p.name,p.description,p.price_cents,p.stock,c.quantity FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.room_id=$1 ORDER BY p.id`, [roomId]),
    db.query('SELECT id,code,percent,expires_at FROM offers WHERE room_id=$1 AND active=true AND expires_at>clock_timestamp() ORDER BY expires_at DESC LIMIT 1', [roomId]),
    db.query('SELECT id,user_id,kind,body,created_at FROM messages WHERE room_id=$1 ORDER BY id DESC LIMIT 80', [roomId]),
    db.query('SELECT id,total_cents,subtotal_cents,discount_cents,offer_code,payment_status,items,created_at FROM orders WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1', [roomId])
  ]);
  const currentOffer = offer.rows[0] || null;
  return { room: room.rows[0], products: products.rows, cart: items.rows, offer: currentOffer, messages: messages.rows.reverse(), latestOrder: latestOrder.rows[0] || null };
}

app.get('/api/health', async () => {
  await db.query('SELECT 1');
  await redis.ping();
  return { ok: true, services: { postgres: 'ok', redis: 'ok' } };
});
app.get('/api/rooms/:roomId/state', async (req, reply) => {
  const userId = req.headers['x-user-id'];
  if (!await membership(req.params.roomId, userId)) return reply.code(403).send({ error: 'This user is not invited to the room.' });
  return snapshot(req.params.roomId);
});
app.post('/api/rooms/:roomId/cart', async (req, reply) => {
  const { roomId } = req.params; const userId = req.headers['x-user-id'];
  if (!await membership(roomId, userId)) return reply.code(403).send({ error: 'This user is not invited to the room.' });
  const { productId, quantity = 1 } = req.body || {};
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return reply.code(400).send({ error: 'Choose between 1 and 10.' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
    const product = await client.query('SELECT stock FROM products WHERE id=$1 FOR UPDATE', [productId]);
    if (!product.rowCount) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Product not found.' }); }
    const old = await client.query('SELECT quantity FROM cart_items WHERE room_id=$1 AND product_id=$2', [roomId, productId]);
    const next = (old.rows[0]?.quantity || 0) + quantity;
    if (next > product.rows[0].stock) { await client.query('ROLLBACK'); return reply.code(409).send({ error: `Only ${product.rows[0].stock} in stock.` }); }
    await client.query(`INSERT INTO cart_items(room_id,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(room_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity`, [roomId, productId, next]);
    const version = await client.query('UPDATE rooms SET cart_version=cart_version+1 WHERE id=$1 RETURNING cart_version', [roomId]);
    await client.query('COMMIT');
    const state = await snapshot(roomId); broadcast(roomId, 'cart_updated', { cart: state.cart, cartVersion: version.rows[0].cart_version });
    return { cart: state.cart, cartVersion: version.rows[0].cart_version };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
app.patch('/api/rooms/:roomId/cart/:productId', async (req, reply) => {
  const { roomId, productId } = req.params; const userId = req.headers['x-user-id'];
  if (!await membership(roomId, userId)) return reply.code(403).send({ error: 'This user is not invited to the room.' });
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10) return reply.code(400).send({ error: 'Invalid quantity.' });
  const client = await db.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
    if (quantity === 0) await client.query('DELETE FROM cart_items WHERE room_id=$1 AND product_id=$2', [roomId, productId]);
    else {
      const p = await client.query('SELECT stock FROM products WHERE id=$1 FOR UPDATE', [productId]);
      if (!p.rowCount || quantity > p.rows[0].stock) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'That quantity is unavailable.' }); }
      await client.query('UPDATE cart_items SET quantity=$3 WHERE room_id=$1 AND product_id=$2', [roomId, productId, quantity]);
    }
    const version = await client.query('UPDATE rooms SET cart_version=cart_version+1 WHERE id=$1 RETURNING cart_version', [roomId]);
    await client.query('COMMIT'); const state = await snapshot(roomId); broadcast(roomId, 'cart_updated', { cart: state.cart, cartVersion: version.rows[0].cart_version }); return { cart: state.cart, cartVersion: version.rows[0].cart_version };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
app.post('/api/rooms/:roomId/chat', async (req, reply) => {
  const { roomId } = req.params; const userId = req.headers['x-user-id'];
  if (!await membership(roomId, userId)) return reply.code(403).send({ error: 'This user is not invited to the room.' });
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 500) return reply.code(400).send({ error: 'Message must be 1–500 characters.' });
  const saved = await db.query(`INSERT INTO messages(room_id,user_id,kind,body) VALUES($1,$2,'user',$3) RETURNING id,user_id,kind,body,created_at`, [roomId, userId, text]);
  const message = saved.rows[0]; broadcast(roomId, 'chat_message', message);
  const job = await queue.add('negotiate', { roomId, userId, text, messageId: message.id }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 200, removeOnFail: 500 });
  req.log.info({ roomId, jobId: job.id }, 'Concierge request queued');
  return reply.code(202).send({ queued: true, jobId: job.id, message });
});
app.post('/api/rooms/:roomId/checkout', async (req, reply) => {
  const { roomId } = req.params; const userId = req.headers['x-user-id'];
  if (!await membership(roomId, userId)) return reply.code(403).send({ error: 'This user is not invited to the room.' });
  const expectedVersion = req.body?.cartVersion;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return reply.code(400).send({ error: 'Refresh the shared cart before checking out.' });
  const requestedOfferCode = String(req.body?.offerCode || '');
  const idempotencyKey = String(req.headers['idempotency-key'] || randomUUID());
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const room = await client.query('SELECT id,cart_version FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
    if (!room.rowCount) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Room not found.' }); }
    const prior = await client.query('SELECT id,total_cents,subtotal_cents,discount_cents,offer_code,payment_status,items,created_at FROM orders WHERE idempotency_key=$1', [idempotencyKey]);
    if (prior.rowCount) { await client.query('COMMIT'); return { order: prior.rows[0], alreadyProcessed: true }; }
    if (room.rows[0].cart_version !== expectedVersion) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'The shared cart changed. Review it and try again.' }); }
    const cart = await client.query(`SELECT p.id,p.name,p.price_cents,p.stock,c.quantity FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.room_id=$1 ORDER BY p.id FOR UPDATE OF p`, [roomId]);
    if (!cart.rowCount) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'The shared cart is empty.' }); }
    for (const item of cart.rows) if (item.quantity > item.stock) { await client.query('ROLLBACK'); return reply.code(409).send({ error: `${item.name} no longer has enough stock.` }); }
    const active = await client.query('SELECT id,code,percent FROM offers WHERE room_id=$1 AND active=true AND expires_at>clock_timestamp() ORDER BY expires_at DESC LIMIT 1', [roomId]);
    const subtotal = cart.rows.reduce((sum, i) => sum + i.price_cents * i.quantity, 0);
    const bundle = cart.rows.find(i => i.id === 'PRD-01');
    const qualifies = active.rowCount > 0 && requestedOfferCode === active.rows[0].code && Number(bundle?.quantity || 0) >= 2;
    const discount = qualifies ? Math.round(bundle.price_cents * bundle.quantity * active.rows[0].percent / 100) : 0;
    const total = subtotal - discount;
    for (const i of cart.rows) await client.query('UPDATE products SET stock=stock-$2 WHERE id=$1', [i.id, i.quantity]);
    const orderId = randomUUID();
    const ins = await client.query('INSERT INTO orders(id,room_id,idempotency_key,items,subtotal_cents,discount_cents,offer_code,total_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,total_cents,subtotal_cents,discount_cents,offer_code,payment_status,items,created_at', [orderId, roomId, idempotencyKey, JSON.stringify(cart.rows.map(({ id,name,quantity,price_cents }) => ({ id,name,quantity,price_cents }))), subtotal, discount, qualifies ? active.rows[0].code : null, total]);
    await client.query('DELETE FROM cart_items WHERE room_id=$1', [roomId]);
    if (qualifies) await client.query('UPDATE offers SET active=false WHERE id=$1', [active.rows[0].id]);
    await client.query('UPDATE rooms SET cart_version=cart_version+1 WHERE id=$1', [roomId]);
    await client.query('COMMIT');
    const state = await snapshot(roomId); const payload = { order: ins.rows[0], cart: state.cart, products: state.products, offer: state.offer, cartVersion: state.room.cart_version };
    req.log.info({ roomId, orderId, totalCents: total }, 'Checkout transaction committed');
    broadcast(roomId, 'Checkout_Complete', payload); return payload;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

io.use(async (socket, next) => {
  const { roomId, userId } = socket.handshake.auth || {};
  try {
    if (!await membership(roomId, userId)) return next(new Error('Room access denied'));
    await socket.join(roomKey(roomId));
    socket.data.roomId = roomId;
    socket.data.userId = userId;
    next();
  }
  catch (e) { next(e); }
});
io.on('connection', socket => { socket.emit('connected', { roomId: socket.data.roomId }); });

async function start() {
  const port = Number(process.env.PORT || 3000);
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  await Promise.all([redis.ping(), adapterPub.ping(), adapterSub.ping(), queue.waitUntilReady()]);
  io.attach(app.server);
  await app.listen({ port, host: '0.0.0.0' });
}
start().catch(err => { app.log.error(err); process.exit(1); });
