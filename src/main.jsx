import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DealRoomProvider, useDealRoom } from './DealRoomContext';
import './styles.css';

const ROOM = 'ROOM-9001';
const PRODUCT_LABELS = ['THE BIG ONE', 'DESK ESSENTIAL', 'MAKE ROOM', 'TYPE WITH EASE', 'ONE-CABLE SETUP', 'TUNE IN', 'LOOK SHARP'];
const money = cents => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const time = date => new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// Local Docker/Vite use same-origin proxying. On Vercel, set
// VITE_API_BASE_URL to the Render API URL including `/api`.
const API = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');

function App() {
  const { user, setUser, state, dispatch, refresh } = useDealRoom();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState('');
  const [order, setOrder] = useState(null);
  const [seconds, setSeconds] = useState(0);
  const chatEnd = useRef(null);
  const { status, typing, stream } = state;
  const cart = state.cart || [];
  const count = cart.reduce((a, item) => a + Number(item.quantity), 0);
  const subtotal = cart.reduce((a, item) => a + Number(item.price_cents) * Number(item.quantity), 0);
  const activeOffer = state.offer && new Date(state.offer.expires_at).getTime() > Date.now() ? state.offer : null;
  const offerProduct = activeOffer && cart.find(item => item.id === activeOffer.product_id);
  const offerProductName = activeOffer?.product_name || state.products.find(product => product.id === activeOffer?.product_id)?.name || 'selected item';
  const discount = activeOffer && Number(offerProduct?.quantity || 0) >= Number(activeOffer.min_quantity || 1)
    ? Math.round(offerProduct.price_cents * offerProduct.quantity * activeOffer.percent / 100)
    : 0;
  const total = subtotal - discount;

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [state.messages, stream, typing]);
  useEffect(() => { if (state.notice) { setToast(state.notice); dispatch({ type: 'clear-notice' }); } }, [state.notice, dispatch]);
  useEffect(() => {
    if (!activeOffer) { setSeconds(0); return; }
    const tick = () => setSeconds(Math.max(0, Math.ceil((new Date(activeOffer.expires_at).getTime() - Date.now()) / 1000)));
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, [activeOffer?.id, activeOffer?.expires_at]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3400); return () => clearTimeout(t); }, [toast]);

  async function call(path, options = {}) {
    const response = await fetch(`${API}${path}`, { ...options, headers: { 'content-type': 'application/json', 'x-user-id': user, ...(options.headers || {}) } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Something went wrong.'); return data;
  }
  async function add(product) {
    try { const data = await call(`/rooms/${ROOM}/cart`, { method: 'POST', body: JSON.stringify({ productId: product.id }) }); dispatch({ type: 'cart', cart: data.cart, cartVersion: data.cartVersion }); setToast('Added to your shared bag'); }
    catch (e) { setToast(e.message); }
  }
  async function quantity(item, amount) {
    try { const data = await call(`/rooms/${ROOM}/cart/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: Number(item.quantity) + amount }) }); dispatch({ type: 'cart', cart: data.cart, cartVersion: data.cartVersion }); }
    catch (e) { setToast(e.message); }
  }
  async function send() {
    const text = draft.trim(); if (!text || sending) return; setDraft(''); setSending(true);
    try { const data = await call(`/rooms/${ROOM}/chat`, { method: 'POST', body: JSON.stringify({ text }) }); dispatch({ type: 'chat-message', message: data.message }); }
    catch (e) { setToast(e.message); setDraft(text); }
    finally { setSending(false); }
  }
  async function checkout() {
    if (!count) return; const key = crypto.randomUUID();
    try { const data = await call(`/rooms/${ROOM}/checkout`, { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify({ cartVersion: Number(state.room?.cart_version), offerCode: state.offer?.code || null }) }); dispatch({ type: 'checkout', event: data }); setOrder(data.order); }
    catch (e) { setToast(e.message); try { await refresh(); } catch {} }
  }
  const inCart = useMemo(() => Object.fromEntries(cart.map(i => [i.id, i.quantity])), [cart]);
  const fmtTimer = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">g</span><span>good company<span className="brand-dot">.</span></span></a><div className="top-center"><span className="room-tag"><i /> PRIVATE ROOM</span><span className="room-code">ROOM-9001</span></div><div className="top-actions"><div className={`live-status ${status}`}><span />{status === 'connected' ? 'Live together' : status === 'offline' ? 'Offline' : 'Reconnecting'}</div><button className="avatar-stack" onClick={() => setUser(user === 'U-101' ? 'U-102' : 'U-101')} title="Switch shopper"><span className="avatar avatar-a">{user === 'U-101' ? 'A' : 'M'}</span><span className="avatar avatar-b">{user === 'U-101' ? 'M' : 'A'}</span><b>2</b></button></div></header>
    <div className="page-head"><div><div className="eyebrow">A LITTLE RETAIL THERAPY, TOGETHER</div><h1>Make a good <em>deal.</em></h1><p className="page-sub">One shared bag. Two opinions. Your call.</p></div><div className="room-note"><div className="note-icon">✳</div><div><strong>You're shopping together</strong><span>Anything either of you adds shows up here.</span></div></div></div>
    <div className="workspace">
      <section className="shop-column"><div className="section-head"><div><span className="eyebrow">THE EDIT</span><h2>Picked for you</h2></div><span className="item-count">{state.products.length} thoughtful finds</span></div>
        <div className="product-grid">{state.products.map((p, index) => <article className={`product-card product-${index + 1}`} key={p.id}>
          <div className="product-art"><span className="product-chip">{PRODUCT_LABELS[index] || 'THE EDIT'}</span><ProductArt index={index}/><span className="art-index">{String(index + 1).padStart(2, '0')}</span></div>
          <div className="product-info"><div className="product-title-row"><div><h3>{p.name}</h3><p>{p.description}</p></div><strong>{money(p.price_cents)}</strong></div><div className="product-bottom"><span className={`stock ${Number(p.stock) < 3 ? 'low-stock' : ''}`}><i />{p.stock} in stock</span><button onClick={() => add(p)} className={`add-button ${inCart[p.id] ? 'added' : ''}`}>{inCart[p.id] ? <>In your bag <span>×{inCart[p.id]}</span></> : <>Add to bag <span>+</span></>}</button></div></div>
        </article>)}</div>
        <div className="little-note"><span>✳</span> Your friend's here too — changes sync as they happen.</div>
      </section>
      <aside className="side-column">
        <section className="bag-card"><div className="bag-head"><div><span className="eyebrow">THE SHARED BAG</span><h2>Your bag <span className="bag-bubble">{count}</span></h2></div><span className="sync-label"><i/> IN SYNC</span></div>
          {activeOffer && <div className="offer-card"><div className="offer-symbol">✳</div><div className="offer-copy"><strong>{activeOffer.percent}% off, just for this room</strong><span>Code {activeOffer.code} · {offerProductName}</span></div><div className="offer-clock"><span>ENDS IN</span><b>{fmtTimer}</b></div></div>}
          {cart.length ? <div className="bag-items">{cart.map(item => <div className="bag-item" key={item.id}><div className={`mini-art mini-${item.id}`}><ProductArt index={Number(item.id.slice(-1)) - 1}/></div><div className="bag-item-main"><strong>{item.name}</strong><span>{money(item.price_cents)} each</span><div className="qty-control"><button onClick={() => quantity(item, -1)}>−</button><b>{item.quantity}</b><button onClick={() => quantity(item, 1)}>+</button></div></div><strong className="line-price">{money(item.price_cents * item.quantity)}</strong></div>)}</div> : <div className="empty-bag"><div className="empty-bag-icon">↗</div><strong>Your shared bag is waiting</strong><span>Add something good. Your friend will see it instantly.</span></div>}
          <div className="bag-totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div>{activeOffer && discount > 0 && <div className="discount-row"><span>Room offer · {activeOffer.percent}%</span><b>−{money(discount)}</b></div>}<div className="total-row"><span>Total</span><b>{money(total)}</b></div></div>
          <button className="checkout-button" disabled={!count} onClick={checkout}><span>Checkout together</span><span>↗</span></button><div className="secure-note"><span>⌑</span> Secure checkout · simulated payment</div>
        </section>
        <section className="concierge-card"><div className="concierge-head"><div className="concierge-icon">✳</div><div><span className="eyebrow">YOUR SHOPPING SIDEKICK</span><h2>Ask the concierge</h2></div><span className="online-pill"><i/> HERE</span></div><p className="concierge-intro">Need a second opinion? Ask about a product, or see if we can make a deal.</p>
          <div className="chat-list">{state.messages.map(msg => <div className={`message ${msg.kind === 'user' ? 'user-message' : 'ai-message'}`} key={msg.id}><span className="message-by">{msg.kind === 'user' ? (msg.user_id === 'U-101' ? 'ALEX' : 'MORGAN') : 'CONCIERGE'} · {time(msg.created_at)}</span><div className="bubble">{msg.body}</div></div>)}{stream && <div className="message ai-message"><span className="message-by">CONCIERGE · NOW</span><div className="bubble">{stream.body}<span className="typing-caret"/></div></div>}{typing && !stream && <div className="message ai-message"><span className="message-by">CONCIERGE · THINKING</span><div className="bubble typing-dots"><i/><i/><i/></div></div>}<div ref={chatEnd}/></div>
          <div className="suggestions"><button onClick={() => setDraft('Can we get a deal on two laptops?')}>Laptop bundle deal?</button><button onClick={() => setDraft('Can I get a discount on two mice?')}>Mouse deal?</button><button onClick={() => setDraft('How many products are out of stock?')}>Check stock ↗</button></div>
          <form className="chat-input" onSubmit={e => { e.preventDefault(); send(); }}><input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask me anything..." maxLength={500}/><button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">↗</button></form><div className="chat-foot">The concierge is a little theatrical. Offers are real (for 3 minutes).</div>
        </section>
      </aside>
    </div>
    <footer className="footer"><span>GOOD COMPANY <i>©</i> 2025</span><span>Better together, by design.</span><span>BUILT FOR THE JOY OF IT ✳</span></footer>
    {toast && <div className="toast"><span>✳</span>{toast}</div>}
    {order && <div className="modal-backdrop" onClick={() => setOrder(null)}><div className="order-modal" onClick={e => e.stopPropagation()}><div className="modal-spark">✳</div><span className="eyebrow">A VERY GOOD DECISION</span><h2>That's a wrap.</h2><p>You and your friend checked out together. Your pretend receipt is ready.</p><div className="receipt"><span>ORDER {String(order.id).slice(0, 8).toUpperCase()}</span><b>{money(order.total_cents)}</b></div><button className="checkout-button" onClick={() => setOrder(null)}>Back to the room <span>↗</span></button></div></div>}
  </main>;
}

function ProductArt({ index = 0 }) {
  return <div className={`illustration ill-${index}`} aria-hidden="true">
    {index === 0 ? <><div className="laptop-screen"><div className="screen-glow"/><span>g.</span></div><div className="laptop-base"/></>
      : index === 1 ? <><div className="mouse-shape"><div className="mouse-line"/><div className="mouse-wheel"/></div><div className="mouse-shadow"/></>
        : index === 2 ? <><div className="monitor-stand"/><div className="monitor"><div className="monitor-screen"><div className="sun"/><div className="hill hill-one"/><div className="hill hill-two"/></div></div><div className="monitor-foot"/></>
          : index === 3 ? <div className="keyboard-shape">{Array.from({ length: 45 }, (_, key) => <i key={key}/>)}</div>
            : index === 4 ? <div className="dock-shape"><i/><i/><i/><i/><b/></div>
              : index === 5 ? <div className="headphones-shape"><i/><b/><span/></div>
                : <div className="webcam-shape"><i/><b/><span/></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<DealRoomProvider><App/></DealRoomProvider>);
