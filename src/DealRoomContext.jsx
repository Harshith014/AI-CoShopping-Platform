import React, { createContext, useContext, useEffect, useReducer, useState } from 'react';
import { io } from 'socket.io-client';

const ROOM = 'ROOM-9001';
// Empty by default so local Vite/Nginx proxies continue to use this origin.
// Set VITE_SOCKET_URL to the Render service origin for a Vercel deployment.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;
const DealRoomContext = createContext(null);

const initialState = {
  room: null, products: [], cart: [], offer: null, messages: [], latestOrder: null,
  status: 'connecting', typing: false, stream: null, notice: ''
};

function reducer(state, action) {
  switch (action.type) {
    case 'hydrate': {
      const savedVersion = Number(state.room?.cart_version ?? -1);
      const incomingVersion = Number(action.payload.room?.cart_version ?? -1);
      const newer = incomingVersion >= savedVersion;
      const messages = [...new Map([...state.messages, ...(action.payload.messages || [])].map(m => [String(m.id), m])).values()]
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(-80);
      return {
        ...state,
        ...action.payload,
        room: { ...action.payload.room, cart_version: Math.max(savedVersion, incomingVersion) },
        products: newer ? action.payload.products : state.products,
        cart: newer ? action.payload.cart : state.cart,
        messages,
        offer: newer ? action.payload.offer : state.offer,
        latestOrder: state.latestOrder && new Date(state.latestOrder.created_at) > new Date(action.payload.latestOrder?.created_at || 0)
          ? state.latestOrder
          : action.payload.latestOrder,
        status: state.status, typing: false, stream: null
      };
    }
    case 'status': return { ...state, status: action.value };
    case 'cart': {
      if (action.cartVersion != null && state.room && Number(action.cartVersion) < Number(state.room.cart_version)) return state;
      return {
      ...state,
      cart: action.cart,
      room: action.cartVersion != null ? { ...(state.room || {}), cart_version: action.cartVersion } : state.room
      };
    }
    case 'chat-message': return state.messages.some(m => String(m.id) === String(action.message.id))
      ? state
      : { ...state, messages: [...state.messages, action.message] };
    case 'offer-created': {
      if (action.cartVersion != null && state.room && Number(action.cartVersion) < Number(state.room.cart_version)) return state;
      return { ...state, offer: action.offer, room: action.cartVersion != null ? { ...(state.room || {}), cart_version: action.cartVersion } : state.room, notice: 'A private 20% bundle offer just landed' };
    }
    case 'offer-expired': {
      const matches = state.offer?.id === action.offerId;
      if (action.cartVersion != null && state.room && Number(action.cartVersion) < Number(state.room.cart_version)) return state;
      return {
        ...state,
        offer: matches ? null : state.offer,
        room: action.cartVersion != null ? { ...(state.room || {}), cart_version: action.cartVersion } : state.room,
        notice: matches ? 'The bundle offer has expired' : state.notice
      };
    }
    case 'typing': return { ...state, typing: action.value, ...(action.value ? { stream: null } : {}) };
    case 'ai-chunk': {
      const stream = action.text
        ? state.stream?.id === action.id
          ? { ...state.stream, body: state.stream.body + action.text }
          : { id: action.id, body: action.text }
        : state.stream;
      if (!action.done) return { ...state, stream };
      const messages = action.message && !state.messages.some(m => String(m.id) === String(action.message.id))
        ? [...state.messages, action.message]
        : state.messages;
      return { ...state, stream: null, typing: false, messages, offer: action.offer || state.offer };
    }
    case 'checkout': return {
      ...state,
      cart: action.event.cart,
      products: action.event.products,
      offer: action.event.offer || null,
      room: action.event.cartVersion != null ? { ...(state.room || {}), cart_version: action.event.cartVersion } : state.room,
      latestOrder: action.event.order,
      notice: 'You checked out together. Nice choice.'
    };
    case 'clear-notice': return { ...state, notice: '' };
    default: return state;
  }
}

export function DealRoomProvider({ children }) {
  const [user, setUser] = useState(() => localStorage.getItem('dealroom-user') || 'U-101');
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => { localStorage.setItem('dealroom-user', user); }, [user]);

  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const response = await fetch(`/api/rooms/${ROOM}/state`, { headers: { 'x-user-id': user } });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not load this deal room.');
        if (!disposed) dispatch({ type: 'hydrate', payload });
      } catch {
        if (!disposed) dispatch({ type: 'status', value: 'offline' });
      }
    }

    dispatch({ type: 'status', value: 'connecting' });
    refresh();
    const socket = io(SOCKET_URL, { auth: { roomId: ROOM, userId: user }, reconnection: true, reconnectionDelay: 400, reconnectionDelayMax: 2500 });
    socket.on('connect', () => { dispatch({ type: 'status', value: 'connected' }); refresh(); });
    socket.on('disconnect', () => dispatch({ type: 'status', value: 'reconnecting' }));
    socket.on('connect_error', () => dispatch({ type: 'status', value: 'reconnecting' }));
    socket.on('cart_updated', event => dispatch({ type: 'cart', cart: event.cart, cartVersion: event.cartVersion }));
    socket.on('offer_created', event => dispatch({ type: 'offer-created', offer: event.offer, cartVersion: event.cartVersion }));
    socket.on('Offer_Expired', event => dispatch({ type: 'offer-expired', offerId: event.offerId, cartVersion: event.cartVersion }));
    socket.on('chat_message', message => dispatch({ type: 'chat-message', message }));
    socket.on('ai_typing', event => dispatch({ type: 'typing', value: event.active }));
    socket.on('ai_chunk', event => dispatch({ type: 'ai-chunk', ...event }));
    socket.on('Checkout_Complete', event => dispatch({ type: 'checkout', event }));
    return () => { disposed = true; socket.disconnect(); };
  }, [user]);

  const refresh = async () => {
    const response = await fetch(`/api/rooms/${ROOM}/state`, { headers: { 'x-user-id': user } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not refresh this deal room.');
    dispatch({ type: 'hydrate', payload });
    return payload;
  };

  return <DealRoomContext.Provider value={{ roomId: ROOM, user, setUser, state, dispatch, refresh }}>{children}</DealRoomContext.Provider>;
}

export function useDealRoom() {
  const value = useContext(DealRoomContext);
  if (!value) throw new Error('useDealRoom must be used inside DealRoomProvider.');
  return value;
}
