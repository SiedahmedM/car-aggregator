-- Stronger indexing for listings queries

-- 1) Make sure the unique constraint exists (safe-guard)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'listings_source_remote_id_key'
  ) THEN
    ALTER TABLE listings
    ADD CONSTRAINT listings_source_remote_id_key
    UNIQUE (source, remote_id);
  END IF;
END$$;

-- 2) Index for make/model queries filtered by source and recency
CREATE INDEX IF NOT EXISTS listings_source_make_model_posted_idx
  ON listings (source, make, model, posted_at DESC);

-- 3) Price range queries (mostly used after make/model filter)
CREATE INDEX IF NOT EXISTS listings_source_make_model_price_idx
  ON listings (source, make, model, price);

-- 4) Year range queries
CREATE INDEX IF NOT EXISTS listings_source_make_model_year_idx
  ON listings (source, make, model, year);

-- 5) Generic recency index for “latest across everything”
CREATE INDEX IF NOT EXISTS listings_posted_at_desc_idx
  ON listings (posted_at DESC);

