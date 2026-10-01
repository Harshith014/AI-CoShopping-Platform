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
  const lower = text.toLowerCase().replace(/[^a-z0-9$./ -]/g, ' ');
  const [catalogResult, cartResult] = await Promise.all([
    db.query('SELECT id,name,description,price_cents,stock FROM products ORDER BY id'),
    db.query(`SELECT p.id,p.name,p.price_cents,c.quantity FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.room_id=$1 ORDER BY p.id`, [roomId])
  ]);
  const products = catalogResult.rows;
  const cart = cartResult.rows;
  const aliases = {
    'PRD-01': ['laptop', 'laptops', 'titanium pro', 'workstation', 'computer', 'notebook'],
    'PRD-02': ['mouse', 'mice', 'wireless mouse', 'ergonomic mouse', 'wireless ergonomic'],
    'PRD-03': ['monitor', 'monitors', 'display', 'screen', 'ultra wide', 'ultrawide', '4k'],
    'PRD-04': ['keyboard', 'keyboards', 'mechanical keyboard', 'keys'],
    'PRD-05': ['dock', 'docking station', 'usb c dock', 'hub'],
    'PRD-06': ['headphone', 'headphones', 'headset', 'noise canceling', 'noise cancelling'],
    'PRD-07': ['webcam', 'web camera', 'camera']
  };
  const mentioned = products.filter(product => {
    const terms = [product.name.toLowerCase(), ...(aliases[product.id] || [])];
    return terms.some(term => lower.includes(term));
  });
  const wantsOffer = /\b(discount|deal|offer|coupon|code|save|cheaper|haggle|bundle|special price|price cut)\b/.test(lower);
  const wantsCatalog = /\b(all|catalog|catalogue|products|items|what do you sell|what's available|what is available)\b/.test(lower);
  const wantsStock = /\b(stock|inventory|available|availability|out of stock|in stock|left|remaining)\b/.test(lower);
  const wantsCount = /\b(how many|count|number of|total)\b/.test(lower);
  const wantsCart = /\b(cart|bag|basket|shared)\b/.test(lower);
  const wantsCompare = /\b(compare|difference|versus|\bvs\b|recommend|recommendation|best|which)\b/.test(lower);
  const offerRules = {
    'PRD-01': { percent: 20, minQuantity: 2, label: 'two-laptop bundle' },
    'PRD-02': { percent: 15, minQuantity: 2, label: 'two-mouse bundle' },
    'PRD-03': { percent: 10, minQuantity: 1, label: 'monitor offer' },
    'PRD-04': { percent: 15, minQuantity: 1, label: 'keyboard offer' },
    'PRD-05': { percent: 12, minQuantity: 1, label: 'dock offer' },
    'PRD-06': { percent: 15, minQuantity: 1, label: 'headphone offer' },
    'PRD-07': { percent: 10, minQuantity: 1, label: 'webcam offer' }
  };
  const money = cents => `$${(Number(cents) / 100).toFixed(2)}`;
  const availability = product => product.stock > 0 ? `${product.stock} in stock` : 'currently out of stock';
  const catalogLine = product => `${product.name} — ${product.description} Price: ${money(product.price_cents)}; ${availability(product)}.`;
  const cartFor = product => cart.find(item => item.id === product.id);
  let answer;
  let offer = null;

  if (wantsOffer && mentioned.length === 1) {
    const product = mentioned[0];
    const rule = offerRules[product.id] || { percent: 10, minQuantity: 1, label: 'room offer' };
    const inCart = cartFor(product);
    if (product.stock <= 0) {
      answer = `${product.name} is currently out of stock, so I can't create an offer for it right now. I can help you choose another item.`;
    } else if (Number(inCart?.quantity || 0) < rule.minQuantity) {
      const requirement = rule.minQuantity === 1 ? 'add it to the shared bag' : `have ${rule.minQuantity} in the shared bag`;
      answer = `I can unlock ${rule.percent}% off ${rule.label} for three minutes. ${product.name} needs to ${requirement}; the room currently has ${Number(inCart?.quantity || 0)}.`;
    } else {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
        const prior = await client.query('SELECT id,code,percent,product_id,min_quantity,expires_at,active,expires_at>clock_timestamp() AS unexpired FROM offers WHERE source_message_id=$1', [job.data.messageId]);
        if (prior.rowCount) {
          if (prior.rows[0].active && prior.rows[0].unexpired) {
            offer = prior.rows[0];
            const currentProduct = products.find(item => item.id === offer.product_id) || product;
            offer.product_name = currentProduct.name;
            const version = await client.query('SELECT cart_version FROM rooms WHERE id=$1', [roomId]);
            offer.cartVersion = version.rows[0].cart_version;
            answer = `Your ${offer.percent}% ${currentProduct.name} offer is active. Use code ${offer.code}; it expires in three minutes.`;
          } else {
            answer = 'That offer is no longer active. Ask me again while the qualifying item is in your shared bag.';
          }
          await client.query('COMMIT');
        } else {
          // Re-check after acquiring the room lock so a stale cart snapshot cannot mint an offer.
          const current = await client.query('SELECT quantity FROM cart_items WHERE room_id=$1 AND product_id=$2', [roomId, product.id]);
          if (Number(current.rows[0]?.quantity || 0) < rule.minQuantity) {
            await client.query('COMMIT');
            answer = `I can unlock ${rule.percent}% off ${rule.label} for three minutes. Add the qualifying quantity to the shared bag, then ask me again.`;
          } else {
            await client.query('UPDATE offers SET active=false WHERE room_id=$1 AND active=true', [roomId]);
            const id = randomUUID();
            const code = `ROOM${rule.percent}-${randomBytes(4).toString('hex').toUpperCase()}`;
            const result = await client.query(`INSERT INTO offers(id,room_id,source_message_id,code,percent,product_id,min_quantity,expires_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '3 minutes')
              RETURNING id,code,percent,product_id,min_quantity,expires_at`, [id, roomId, job.data.messageId, code, rule.percent, product.id, rule.minQuantity]);
            offer = { ...result.rows[0], product_name: product.name };
            const version = await client.query('UPDATE rooms SET cart_version=cart_version+1 WHERE id=$1 RETURNING cart_version', [roomId]);
            offer.cartVersion = version.rows[0].cart_version;
            await client.query('COMMIT');
            answer = `Deal unlocked: ${offer.percent}% off ${product.name} in your shared bag. Use code ${offer.code} within three minutes.`;
          }
        }
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      if (offer) {
        console.log(`Created ${offer.percent}% offer ${offer.code} for ${offer.product_name || product.name} in room ${roomId}`);
        broadcast(roomId, 'offer_created', { offer, cartVersion: offer.cartVersion });
      }
    }
  } else if (wantsOffer && mentioned.length > 1) {
    answer = `I can create one timed room offer at a time. Which item should I check: ${mentioned.map(p => p.name).join(', ')}?`;
  } else if (wantsOffer) {
    answer = 'I can check a three-minute room offer for any item: 20% off two laptops, 15% off two mice, 10% off a monitor, 15% off a keyboard, 12% off a USB-C dock, 15% off headphones, or 10% off a webcam. Add the qualifying item(s) to your shared bag, then ask me about that product.';
  } else if (mentioned.length === 1) {
    const product = mentioned[0];
    answer = `${catalogLine(product)} ${product.stock > 0 ? `It's available to add to your shared bag. Ask me for a timed deal on it too.` : 'I can help you compare it with the other items.'}`;
  } else if (mentioned.length > 1 || wantsCompare) {
    const available = products.filter(product => product.stock > 0);
    const recommendation = available.find(product => product.id === 'PRD-02') || available[0];
    const recommendationText = recommendation
      ? `For a practical desk setup, consider the ${recommendation.name}.`
      : 'Everything is currently out of stock.';
    answer = products.length
      ? `Here's the quick comparison:\n${products.map(catalogLine).join('\n')}\n${recommendationText}`
      : 'The catalog is empty right now, so I can’t compare products yet.';
  } else if (wantsCatalog && !wantsStock && !wantsCount) {
    answer = products.length
      ? `Here are all ${products.length} products in the catalog:\n${products.map(catalogLine).join('\n')}`
      : 'There are no products in the catalog right now.';
  } else if (wantsCart) {
    answer = cart.length
      ? `Your shared bag has ${cart.reduce((sum, item) => sum + Number(item.quantity), 0)} item(s): ${cart.map(item => `${item.quantity} × ${item.name} (${money(item.price_cents * item.quantity)})`).join(', ')}. Subtotal: ${money(cart.reduce((sum, item) => sum + item.price_cents * item.quantity, 0))}.`
      : 'Your shared bag is empty at the moment. Add something from the catalog and I’ll keep both shoppers in sync.';
  } else if (wantsStock || wantsCount || wantsCatalog) {
    const out = products.filter(product => Number(product.stock) <= 0);
    const available = products.filter(product => Number(product.stock) > 0);
    const units = products.reduce((sum, product) => sum + Number(product.stock), 0);
    answer = `The catalog has ${products.length} distinct products; ${available.length} are in stock and ${out.length} are out of stock, with ${units} units available in total. ${out.length ? `Out of stock: ${out.map(product => product.name).join(', ')}.` : 'Everything currently has stock.'} Ask about a product for its description, price, and exact stock.`;
  } else {
    answer = 'I can describe products, compare prices and stock, summarize the shared bag, or check a timed discount. Our catalog includes a Titanium Pro Laptop, Wireless Ergonomic Mouse, 4K Ultra-Wide Monitor, Studio Mechanical Keyboard, Compact USB-C Dock, Studio Noise-Canceling Headphones, and 4K Desk Webcam. What would help?';
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
