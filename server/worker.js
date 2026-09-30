const { Worker } = require('bullmq');
const { Emitter } = require('@socket.io/redis-emitter');
const IORedis = require('ioredis');
const { randomUUID, randomBytes } = require('node:crypto');
const db = require('./db');
const { connection } = require('./queue');
const emitter = new Emitter(new IORedis(process.env.REDIS_URL || 'redis://localhost:6379'));
const roomKey = id => `room:${id}`;
const broadcast = (id, event, data) => emitter.to(roomKey(id)).emit(event, data);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function negotiate(job) {
  const { roomId, text, userId } = job.data;
  broadcast(roomId, 'ai_typing', { active: true, jobId: job.id });
  await wait(10_000);
  const lower = text.toLowerCase();
  let answer = lower.includes('laptop')
    ? 'The Titanium Pro is a high-performance workstation. Add two to your shared bag and ask me about the bundle offer.'
    : lower.includes('discount') || lower.includes('deal') || lower.includes('offer')
      ? 'I can keep an eye out for a bundle. Add two Titanium Pro laptops to your shared bag and ask me to check the deal.'
      : 'Happy to help you compare. The Titanium Pro is a high-performance workstation, the ergonomic mouse is $85, and the ultra-wide monitor is $450. Ask me about a bundle deal any time.';
  let offer = null;
  if (lower.includes('laptop') && (lower.includes('two') || lower.includes('2') || lower.includes('buy'))) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
      const prior = await client.query('SELECT id,code,percent,expires_at,active,expires_at>clock_timestamp() AS unexpired FROM offers WHERE source_message_id=$1', [job.data.messageId]);
      if (prior.rowCount) {
        if (prior.rows[0].active && prior.rows[0].unexpired) {
          offer = prior.rows[0];
          const version = await client.query('SELECT cart_version FROM rooms WHERE id=$1', [roomId]);
          offer.cartVersion = version.rows[0].cart_version;
          answer = `Deal unlocked. Use code ${offer.code} for 20% off the two Titanium Pro laptops in your shared bag. It expires in three minutes.`;
        } else {
          answer = 'That bundle offer has expired. Ask me again while two Titanium Pro laptops are in your shared bag.';
        }
        await client.query('COMMIT');
      } else {
        const quantities = await client.query('SELECT COALESCE(SUM(quantity),0)::int AS qty FROM cart_items WHERE room_id=$1 AND product_id=$2', [roomId, 'PRD-01']);
        if (quantities.rows[0].qty >= 2) {
          await client.query('UPDATE offers SET active=false WHERE room_id=$1 AND active=true', [roomId]);
          const id = randomUUID();
          const code = `ROOM20-${randomBytes(4).toString('hex').toUpperCase()}`;
          const result = await client.query(`INSERT INTO offers(id,room_id,source_message_id,code,percent,expires_at) VALUES($1,$2,$3,$4,20,clock_timestamp()+interval '3 minutes') RETURNING id,code,percent,expires_at`, [id, roomId, job.data.messageId, code]);
          offer = result.rows[0];
          const version = await client.query('UPDATE rooms SET cart_version=cart_version+1 WHERE id=$1 RETURNING cart_version', [roomId]);
          offer.cartVersion = version.rows[0].cart_version;
          answer = `Deal unlocked. Use code ${offer.code} for 20% off the two Titanium Pro laptops in your shared bag. It expires in exactly three minutes.`;
          await client.query('COMMIT');
        } else {
          await client.query('COMMIT');
          answer = 'I can offer 20% off a two-laptop bundle for three minutes. Add both Titanium Pro laptops to your shared bag and I’ll unlock it.';
        }
      }
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (offer) broadcast(roomId, 'offer_created', { offer, cartVersion: offer.cartVersion });
  }

  // Stream the mock answer in small pieces to every connected shopper.
  const id = `ai-${job.id}`;
  for (let i = 0; i < answer.length; i += 14) {
    broadcast(roomId, 'ai_chunk', { id, text: answer.slice(i, i + 14), done: false });
    await wait(55);
  }
  const saved = await db.query(`INSERT INTO messages(room_id,user_id,kind,reply_to_message_id,body) VALUES($1,$2,'assistant',$3,$4) ON CONFLICT(reply_to_message_id) DO UPDATE SET body=EXCLUDED.body RETURNING id,user_id,kind,body,created_at`, [roomId, userId, job.data.messageId, answer]);
  broadcast(roomId, 'ai_chunk', { id, text: '', done: true, message: saved.rows[0], offer });
  broadcast(roomId, 'ai_typing', { active: false, jobId: job.id });
}

const worker = new Worker('deal-room-jobs', async job => {
  if (job.name === 'negotiate') return negotiate(job);
}, { connection, concurrency: 1 });
worker.on('failed', (job, err) => {
  console.error('Job failed', job?.id, err);
  if (job?.data?.roomId) broadcast(job.data.roomId, 'ai_typing', { active: false, jobId: job.id });
});
worker.on('completed', job => console.log(`Completed ${job.name} job ${job.id}`));

// PostgreSQL is the source of truth. A recurring worker sweep makes expiration
// recover automatically after worker or Redis restarts, without browser timers.
let expirySweepRunning = false;
async function expireDueOffers() {
  if (expirySweepRunning) return;
  expirySweepRunning = true;
  try {
    const candidates = await db.query('SELECT id,room_id,code FROM offers WHERE active=true AND expires_at<=clock_timestamp() ORDER BY expires_at');
    for (const candidate of candidates.rows) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [candidate.room_id]);
        const expired = await client.query('UPDATE offers SET active=false WHERE id=$1 AND active=true AND expires_at<=clock_timestamp() RETURNING id,room_id,code', [candidate.id]);
        if (!expired.rowCount) { await client.query('COMMIT'); continue; }
        const version = await client.query('UPDATE rooms SET cart_version=cart_version+1 WHERE id=$1 RETURNING cart_version', [candidate.room_id]);
        const cart = await client.query('SELECT p.id,p.name,p.description,p.price_cents,p.stock,c.quantity FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.room_id=$1 ORDER BY p.id', [candidate.room_id]);
        await client.query('COMMIT');
        const cartVersion = version.rows[0]?.cart_version;
        console.log(`Expired offer ${candidate.code} in room ${candidate.room_id}`);
        broadcast(candidate.room_id, 'Offer_Expired', { offerId: candidate.id, code: candidate.code, cartVersion });
        broadcast(candidate.room_id, 'cart_updated', { cart: cart.rows, cartVersion });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
  } finally { expirySweepRunning = false; }
}
expireDueOffers().catch(err => console.error('Offer expiry sweep failed', err));
const expiryTimer = setInterval(() => expireDueOffers().catch(err => console.error('Offer expiry sweep failed', err)), 1000);
expiryTimer.unref();
console.log('Deal room worker ready');
