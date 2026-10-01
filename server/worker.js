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
  const [catalogResult, cartResult, roomResult, offerResult, orderResult, orderCountResult, messagesResult, messageCountResult] = await Promise.all([
    db.query('SELECT id,name,description,price_cents,stock FROM products ORDER BY id'),
    db.query(`SELECT p.id,p.name,p.price_cents,c.quantity FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.room_id=$1 ORDER BY p.id`, [roomId]),
    db.query('SELECT id,name,members,cart_version FROM rooms WHERE id=$1', [roomId]),
    db.query(`SELECT o.id,o.code,o.percent,o.product_id,o.min_quantity,o.expires_at,
        EXTRACT(EPOCH FROM (o.expires_at-clock_timestamp()))::int AS remaining_seconds,p.name AS product_name
      FROM offers o LEFT JOIN products p ON p.id=o.product_id
      WHERE o.room_id=$1 AND o.active=true AND o.expires_at>clock_timestamp()
      ORDER BY o.expires_at DESC LIMIT 1`, [roomId]),
    db.query(`SELECT id,total_cents,subtotal_cents,discount_cents,offer_code,payment_status,items,created_at
      FROM orders WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1`, [roomId]),
    db.query('SELECT COUNT(*)::int AS count FROM orders WHERE room_id=$1', [roomId]),
    db.query('SELECT id,user_id,kind,body,created_at FROM messages WHERE room_id=$1 ORDER BY id DESC LIMIT 12', [roomId]),
    db.query('SELECT COUNT(*)::int AS count FROM messages WHERE room_id=$1', [roomId])
  ]);
  const products = catalogResult.rows;
  const cart = cartResult.rows;
  const room = roomResult.rows[0];
  const activeOffer = offerResult.rows[0] || null;
  const latestOrder = orderResult.rows[0] || null;
  const orderCount = orderCountResult.rows[0]?.count || 0;
  const messageCount = messageCountResult.rows[0]?.count || 0;
  const recentMessages = messagesResult.rows.reverse().filter(message => String(message.id) !== String(job.data.messageId));
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
  const wantsCart = /\b(cart|bag|basket|added)\b|\bput (?:it|that|them|something) in\b|\bshopping (?:cart|bag)\b/.test(lower);
  const wantsOrder = /\b(order|checkout|payment|receipt|purchased|bought|paid)\b/.test(lower);
  const wantsRoom = /\b(room|shopper|participant|member|invite)\b/.test(lower);
  const wantsConversation = /\b(messages?|chat|conversation|asked|said|talked|discussed)\b/.test(lower);
  const wantsPresence = /\b(online|offline|connected|disconnected|live together)\b/.test(lower);
  const wantsCartTotal = /\b(total|subtotal|cost|amount|spend|price)\b/.test(lower);
  const wantsSyncHelp = /\b(sync|synchron|reconnect|refresh|updating|out of sync|stale)\b/.test(lower);
  const wantsSalesData = /\b(best selling|bestseller|top seller|most popular|sales ranking)\b/.test(lower);
  const wantsUnbackedInfo = /\b(rating|ratings|review|reviews|stars|shipping|delivery date|warranty|refund|return policy|tracking number)\b/.test(lower);
  const asksHow = /\b(how|where|can i|what do i)\b/.test(lower);
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

  if (wantsOffer && mentioned.length === 1 && activeOffer?.product_id === mentioned[0].id) {
    const offerItem = cart.find(item => item.id === activeOffer.product_id);
    const qualifies = Number(offerItem?.quantity || 0) >= Number(activeOffer.min_quantity || 1);
    const savings = qualifies ? Math.round(offerItem.price_cents * offerItem.quantity * activeOffer.percent / 100) : 0;
    answer = `Yes, the ${activeOffer.percent}% offer for ${activeOffer.product_name || mentioned[0].name} is active. Use code ${activeOffer.code}; it expires in about ${Math.ceil(activeOffer.remaining_seconds / 60)} minute(s). ${qualifies ? `On the ${offerItem.quantity} currently in your bag, that saves ${money(savings)}.` : `It applies when your cart has at least ${activeOffer.min_quantity} of that item.`}`;
  } else if (wantsOffer && mentioned.length === 1) {
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
    answer = activeOffer
      ? `There is an active ${activeOffer.percent}% offer for the ${activeOffer.product_name || 'selected item'} in this room. Code ${activeOffer.code} is valid for about ${Math.ceil(activeOffer.remaining_seconds / 60)} more minute(s).`
      : `No room offer is active right now. I can check one for any item: ${Object.entries(offerRules).map(([id, rule]) => {
        const product = products.find(item => item.id === id);
        return product ? `${rule.percent}% off ${product.name}${rule.minQuantity > 1 ? ` when you add ${rule.minQuantity}` : ''}` : null;
      }).filter(Boolean).join('; ')}. Add the qualifying item(s) to the shared bag, then ask me about that product.`;
  } else if (wantsCart) {
    const itemCount = cart.reduce((sum, item) => sum + Number(item.quantity), 0);
    const subtotal = cart.reduce((sum, item) => sum + Number(item.price_cents) * Number(item.quantity), 0);
    const offerItem = activeOffer && cart.find(item => item.id === activeOffer.product_id);
    const hasOfferQuantity = activeOffer && Number(offerItem?.quantity || 0) >= Number(activeOffer.min_quantity || 1);
    const discount = hasOfferQuantity ? Math.round(offerItem.price_cents * offerItem.quantity * activeOffer.percent / 100) : 0;
    if (wantsSyncHelp) {
      const lines = cart.length ? cart.map(item => `${item.quantity} × ${item.name}`).join('; ') : 'empty';
      answer = `The latest server snapshot is cart version ${room?.cart_version ?? 'unknown'} and contains: ${lines}. Socket.IO broadcasts cart edits; after reconnect, the page reloads this saved state. Check for “Live together” at the top, then refresh if the other window still looks different.`;
    } else if (mentioned.length === 1) {
      const product = mentioned[0];
      const cartItem = cart.find(item => item.id === product.id);
      answer = cartItem
        ? `${Number(cartItem.quantity)} × ${product.name} ${Number(cartItem.quantity) === 1 ? 'is' : 'are'} in your shared cart. That's ${money(cartItem.price_cents)} each, ${money(cartItem.price_cents * cartItem.quantity)} total. ${product.stock} remain in stock.`
        : product.stock > 0
          ? `${product.name} isn't in the shared cart right now. There ${product.stock === 1 ? 'is' : 'are'} ${product.stock} in stock if you'd like to add it.`
          : `${product.name} isn't in the shared cart and is currently out of stock, so it can't be added right now.`;
    } else if (!cart.length) {
      answer = 'The shared cart is empty right now. Add an item from the product list and it will appear for both shoppers.';
    } else if (wantsCartTotal) {
      const lines = cart.map(item => `${item.quantity} × ${item.name}: ${money(item.price_cents * item.quantity)}`).join('; ');
      answer = `Your shared cart has ${itemCount} item(s): ${lines}. Subtotal ${money(subtotal)}${discount ? `, less the active ${activeOffer.percent}% offer (${money(discount)})` : ''}; total ${money(subtotal - discount)}.`;
    } else {
      const lines = cart.map(item => `${item.quantity} × ${item.name} (${money(item.price_cents * item.quantity)})`).join('; ');
      answer = `${['Here is what you have in the shared cart', 'I checked the shared cart', 'Current shared-cart items'][Number(job.data.messageId || 0) % 3]}: ${lines}. ${itemCount} item(s) total, subtotal ${money(subtotal)}${discount ? ` and total after the active offer ${money(subtotal - discount)}` : ''}.`;
    }
  } else if (wantsOrder) {
    if (asksHow && /\b(checkout|pay|payment)\b/.test(lower)) {
      answer = 'When you are ready, select “Checkout together” below the shared cart. The API rechecks stock and any active offer, then records one simulated order for both shoppers. No real payment is taken.';
    } else if (!latestOrder) {
      answer = orderCount
        ? `This room has ${orderCount} previous order(s), but no completed order details were returned. Use “Checkout together” when you're ready; payment is simulated.`
        : 'There is no completed order for this room yet. The cart contents and current prices are shown in the shared bag; use “Checkout together” when you are ready. Payment is simulated.';
    } else {
      const items = Array.isArray(latestOrder.items) ? latestOrder.items : [];
      const orderItems = items.map(item => `${item.quantity} × ${item.name}`).join('; ');
      answer = `The latest room order is ${String(latestOrder.id).slice(0, 8).toUpperCase()}, recorded ${new Date(latestOrder.created_at).toISOString()}. Status: ${latestOrder.payment_status === 'simulated_paid' ? 'simulated payment complete' : latestOrder.payment_status}. Items: ${orderItems || 'details unavailable'}. Total ${money(latestOrder.total_cents)}${latestOrder.offer_code ? ` with offer ${latestOrder.offer_code}` : ''}.`;
    }
    if (wantsCount && orderCount > 0) answer = `This room has completed ${orderCount} order(s). ${latestOrder ? `The latest is ${String(latestOrder.id).slice(0, 8).toUpperCase()} for ${money(latestOrder.total_cents)}.` : ''}`;
  } else if (wantsConversation) {
    if (wantsCount) {
      answer = `There are ${messageCount} saved chat message(s) in this room. The chat panel hydrates the latest 80 after reconnect.`;
    } else {
      const requestedUser = /\b(friend|other shopper)\b/.test(lower) ? (userId === 'U-101' ? 'U-102' : 'U-101') : null;
      const relevant = recentMessages.filter(message => !requestedUser || message.user_id === requestedUser).slice(-4);
      answer = relevant.length
        ? `Recent room conversation: ${relevant.map(message => `${message.kind === 'assistant' ? 'Concierge' : message.user_id === 'U-101' ? 'Alex' : 'Morgan'}: “${message.body}”`).join(' · ')}`
        : 'There are no earlier saved chat messages to summarize yet. Messages will appear here after the concierge replies.';
    }
  } else if (wantsRoom) {
    const memberNames = (room?.members || []).map(id => id === 'U-101' ? 'Alex (U-101)' : id === 'U-102' ? 'Morgan (U-102)' : id).join(' and ');
    answer = `You're in “${room?.name || roomId}” (${room?.id || roomId}). Invited shoppers: ${memberNames || 'none listed'}. Both members share the same cart and chat. I can confirm who is invited, but this API doesn't expose live online presence.`;
  } else if (wantsPresence) {
    answer = 'The top-right “Live together” indicator shows whether this browser is connected to the room’s Socket.IO server. This demo does not store each invited shopper’s live online status, so check the indicator in your friend’s browser to confirm their connection.';
  } else if (wantsSalesData) {
    answer = 'This demo does not track sales rankings, ratings, or customer reviews, so I can’t identify a best seller. I can compare the seven items by their descriptions, prices, and live stock instead.';
  } else if (wantsUnbackedInfo) {
    answer = 'That information is not configured in this demo. The site tracks product descriptions, prices, stock, room offers, shared-cart contents, and simulated orders; it does not have review, shipping, warranty, or refund data.';
  } else if (mentioned.length === 1) {
    const product = mentioned[0];
    answer = `${['About the item you asked about', 'Here are the current details', 'I looked it up'][Number(job.data.messageId || 0) % 3]}: ${catalogLine(product)} ${product.stock > 0 ? 'You can add it to the shared bag.' : 'It cannot be added until it is back in stock.'}`;
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
