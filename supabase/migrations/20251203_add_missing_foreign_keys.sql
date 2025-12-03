-- Add missing foreign key constraints to prevent orphaned records
-- This ensures that when a listing is deleted, related records are cleaned up automatically

-- 1. dismissed_deals → listings
-- Add foreign key with CASCADE delete
ALTER TABLE dismissed_deals
ADD CONSTRAINT dismissed_deals_listing_id_fkey
FOREIGN KEY (listing_id)
REFERENCES listings(id)
ON DELETE CASCADE;

-- 2. saved_deals → listings
ALTER TABLE saved_deals
ADD CONSTRAINT saved_deals_listing_id_fkey
FOREIGN KEY (listing_id)
REFERENCES listings(id)
ON DELETE CASCADE;

-- 3. arbitrage_valuations → listings
ALTER TABLE arbitrage_valuations
ADD CONSTRAINT arbitrage_valuations_listing_id_fkey
FOREIGN KEY (listing_id)
REFERENCES listings(id)
ON DELETE CASCADE;

-- Create indexes for performance on foreign key columns
CREATE INDEX IF NOT EXISTS idx_dismissed_deals_listing_id ON dismissed_deals(listing_id);
CREATE INDEX IF NOT EXISTS idx_saved_deals_listing_id ON saved_deals(listing_id);
CREATE INDEX IF NOT EXISTS idx_arbitrage_valuations_listing_id ON arbitrage_valuations(listing_id);
