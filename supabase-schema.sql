-- Supabase Schema for GlowCraft Organics Skincare Store
-- Run this in your Supabase SQL Editor (Project: tppzhrytdheozsoebnex.supabase.co)

CREATE TABLE IF NOT EXISTS skincare_orders (
  id BIGSERIAL PRIMARY KEY,
  reference VARCHAR(100) UNIQUE NOT NULL,
  security_pin VARCHAR(10) NOT NULL,
  seal_number VARCHAR(50),
  courier_name VARCHAR(150),
  customer_name VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(50) NOT NULL,
  customer_email VARCHAR(255),
  fulfillment_type VARCHAR(50) DEFAULT 'DELIVERY',
  shipping_zone VARCHAR(150) NOT NULL,
  delivery_address TEXT NOT NULL,
  items JSONB NOT NULL,
  items_summary TEXT,
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  shipping_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12, 2) NOT NULL,
  payment_status VARCHAR(50) DEFAULT 'PAID',
  status VARCHAR(50) DEFAULT 'FORMULATING',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE skincare_orders ENABLE ROW LEVEL SECURITY;

-- Allow public anonymous insert for checkout
CREATE POLICY "Allow public insert on skincare_orders"
ON skincare_orders FOR INSERT
WITH CHECK (true);

-- Allow public read for order tracking by reference
CREATE POLICY "Allow public read on skincare_orders"
ON skincare_orders FOR SELECT
USING (true);

-- Allow updates (e.g. status changes from vendor)
CREATE POLICY "Allow public update on skincare_orders"
ON skincare_orders FOR UPDATE
USING (true);
