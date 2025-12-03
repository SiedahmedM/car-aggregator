-- ============================================================================
-- MIGRATION: Track NEW vs SEEN listings for deduplication
-- Date: 2025-11-26
-- Purpose: Enable detection of truly NEW listings vs re-scraped old ones
-- ============================================================================

-- Add tracking columns to listings table
ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seen_count INTEGER DEFAULT 1;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_new BOOLEAN DEFAULT TRUE;

-- Backfill existing rows (mark all existing listings as NOT new)
UPDATE listings SET
  last_seen_at = first_seen_at,
  seen_count = 1,
  is_new = FALSE  -- Existing listings aren't "new" anymore
WHERE last_seen_at IS NULL;

-- Add indexes for efficient NEW listing queries
CREATE INDEX IF NOT EXISTS listings_new_recent_idx
  ON listings (source, make, model, is_new, first_seen_at DESC)
  WHERE is_new = TRUE;

CREATE INDEX IF NOT EXISTS listings_last_seen_idx
  ON listings (last_seen_at DESC);

-- Add index for checking existence by remote_id (for detectNewListings)
CREATE INDEX IF NOT EXISTS listings_source_remote_id_lookup
  ON listings (source, remote_id);

COMMENT ON COLUMN listings.last_seen_at IS 'Timestamp of when we last saw this listing during a scrape';
COMMENT ON COLUMN listings.seen_count IS 'Number of times we''ve encountered this listing across scrapes';
COMMENT ON COLUMN listings.is_new IS 'TRUE only on first insert, set to FALSE on subsequent updates';
