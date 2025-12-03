-- Run this SQL in Supabase SQL Editor to create the watched_listings table
-- This enables the Watch/Unwatch functionality in the Live Market Feed

CREATE TABLE IF NOT EXISTS watched_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  watched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watched_listings_listing_id ON watched_listings(listing_id);
CREATE INDEX IF NOT EXISTS idx_watched_listings_watched_at ON watched_listings(watched_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_listings_unique_listing ON watched_listings(listing_id);

COMMENT ON TABLE watched_listings IS 'Tracks listings that users have saved/bookmarked for watching';
