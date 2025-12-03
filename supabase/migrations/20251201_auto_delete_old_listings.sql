-- Auto-delete listings older than 7 days
-- This migration sets up automatic cleanup of old listings

-- Create a function to delete old listings
CREATE OR REPLACE FUNCTION delete_old_listings()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete listings where first_seen_at is older than 7 days
  DELETE FROM listings
  WHERE first_seen_at < NOW() - INTERVAL '7 days';

  RAISE NOTICE 'Deleted old listings older than 7 days';
END;
$$;

-- Grant execute permission to authenticated users (optional, adjust as needed)
GRANT EXECUTE ON FUNCTION delete_old_listings() TO authenticated;

-- Enable pg_cron extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule the cleanup to run daily at 3 AM UTC
-- Note: pg_cron requires superuser privileges and may not be available on all Supabase plans
-- If pg_cron is not available, you can call this function manually or via an external cron job
SELECT cron.schedule(
  'delete-old-listings',           -- job name
  '0 3 * * *',                     -- cron expression: daily at 3 AM
  $$SELECT delete_old_listings()$$ -- SQL to execute
);

-- Alternative: If pg_cron is not available, create a policy-based approach
-- Comment out the above pg_cron section and uncomment below:

/*
-- Create a view that only shows listings from the last 7 days
CREATE OR REPLACE VIEW recent_listings AS
SELECT * FROM listings
WHERE first_seen_at >= NOW() - INTERVAL '7 days';

-- Note: You would then need to update your application to query from 'recent_listings' view
-- instead of 'listings' table, or manually call delete_old_listings() periodically
*/

COMMENT ON FUNCTION delete_old_listings() IS 'Deletes listings older than 7 days based on first_seen_at timestamp';
