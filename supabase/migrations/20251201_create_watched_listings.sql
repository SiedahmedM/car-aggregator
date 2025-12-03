-- Create watched_listings table to track user-saved listings
-- This allows users to save listings they're interested in

-- Create the table
CREATE TABLE IF NOT EXISTS watched_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  watched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index for fast lookups by listing_id
CREATE INDEX IF NOT EXISTS idx_watched_listings_listing_id ON watched_listings(listing_id);

-- Create index for ordering by watched_at
CREATE INDEX IF NOT EXISTS idx_watched_listings_watched_at ON watched_listings(watched_at DESC);

-- Ensure a listing can only be watched once (prevent duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_listings_unique_listing ON watched_listings(listing_id);

COMMENT ON TABLE watched_listings IS 'Tracks listings that users have saved/bookmarked for watching';
COMMENT ON COLUMN watched_listings.listing_id IS 'Foreign key to the listings table';
COMMENT ON COLUMN watched_listings.watched_at IS 'Timestamp when the user saved this listing';
