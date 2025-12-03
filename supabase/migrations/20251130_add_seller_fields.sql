-- Migration: Add seller detection fields to listings table
-- Purpose: Store dealer/seller information for filtering and analysis
-- Date: 2025-11-30

-- Add seller information columns (all nullable for backward compatibility)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_dealer BOOLEAN DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_name TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_business_name TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_verified BOOLEAN DEFAULT FALSE;

-- Add filtered index for efficient queries (only index non-dealer listings)
-- This optimizes the common query: "SELECT * FROM listings WHERE is_dealer = FALSE"
CREATE INDEX IF NOT EXISTS listings_is_dealer_idx
  ON listings (is_dealer)
  WHERE is_dealer = FALSE;

-- Add index for dealer name lookups (useful for analytics)
CREATE INDEX IF NOT EXISTS listings_seller_business_name_idx
  ON listings (seller_business_name)
  WHERE seller_business_name IS NOT NULL;

-- Comments for documentation
COMMENT ON COLUMN listings.is_dealer IS 'True if listing is from a verified dealer/business, false for private sellers';
COMMENT ON COLUMN listings.seller_name IS 'Seller display name (person or business)';
COMMENT ON COLUMN listings.seller_business_name IS 'Business/dealership name (only for dealers)';
COMMENT ON COLUMN listings.seller_verified IS 'TruYou or platform-verified seller status';
