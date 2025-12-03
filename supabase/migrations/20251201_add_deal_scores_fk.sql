-- Add foreign key relationship between deal_scores and listings
-- This enables Supabase to perform joins between the tables

-- First, ensure any orphaned records are cleaned up (optional safety check)
-- Delete deal_scores that reference non-existent listings
DELETE FROM deal_scores
WHERE listing_id NOT IN (SELECT id FROM listings);

-- Add the foreign key constraint
ALTER TABLE deal_scores
ADD CONSTRAINT deal_scores_listing_id_fkey
FOREIGN KEY (listing_id)
REFERENCES listings(id)
ON DELETE CASCADE;

-- Create an index on listing_id for better join performance
CREATE INDEX IF NOT EXISTS idx_deal_scores_listing_id ON deal_scores(listing_id);

-- Also ensure job_id has an index for performance
CREATE INDEX IF NOT EXISTS idx_deal_scores_job_id ON deal_scores(job_id);

COMMENT ON CONSTRAINT deal_scores_listing_id_fkey ON deal_scores IS 'Links deal scores to their corresponding listings';
