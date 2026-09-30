CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'The good stuff room',
  members TEXT[] NOT NULL,
  cart_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);
CREATE TABLE IF NOT EXISTS cart_items (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (room_id, product_id)
);
CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  source_message_id BIGINT,
  code TEXT NOT NULL,
  percent INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','assistant','system')),
  reply_to_message_id BIGINT REFERENCES messages(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  payment_status TEXT NOT NULL DEFAULT 'simulated_paid',
  items JSONB NOT NULL,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  offer_code TEXT,
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent migrations also run when a named Docker volume already contains an older schema.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS cart_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS source_message_id BIGINT;
UPDATE offers SET code = 'ROOM-' || upper(substr(replace(id::text, '-', ''), 1, 8)) WHERE code IS NULL;
ALTER TABLE offers ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS offers_code_unique_idx ON offers(code);
CREATE UNIQUE INDEX IF NOT EXISTS offers_source_message_unique_idx ON offers(source_message_id);
DO $$ BEGIN
  ALTER TABLE offers ADD CONSTRAINT offers_source_message_fk FOREIGN KEY (source_message_id) REFERENCES messages(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'simulated_paid';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT REFERENCES messages(id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_reply_once_idx ON messages(reply_to_message_id);
INSERT INTO rooms (id, name, members) VALUES ('ROOM-9001', 'The good stuff room', ARRAY['U-101','U-102']) ON CONFLICT (id) DO NOTHING;
INSERT INTO products (id,name,description,price_cents,stock) VALUES
('PRD-01','Titanium Pro Laptop','High-performance workstation.',120000,4),
('PRD-02','Wireless Ergonomic Mouse','Reduces wrist strain during long sessions.',8500,50),
('PRD-03','4K Ultra-Wide Monitor','34-inch curved display.',45000,1)
ON CONFLICT (id) DO NOTHING;
