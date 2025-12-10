# Facebook Scraper Chronological Sorting Fix

## Problem Identified

The Facebook scraper was not returning true chronological results because:

1. **`params.query` triggers relevance ranking**: When make/model filters were specified (e.g., `FB_MAKE=honda FB_MODEL=civic`), the code was injecting `params.query = "Honda Civic"` into GraphQL variables. Facebook's API interprets this as a search query and switches to **RELEVANCE ranking** instead of chronological sorting, even when `filterSortingParams` is set to `CREATION_TIME`.

2. **Evidence**: The saved request file `facebook_gql_feed_req.json` shows `params.query: "Honda Civic"` was present, which explains why results were not chronological.

## Solution Implemented

### 1. Removed `params.query` Injection
- **Before**: Code injected `params.query` with make/model search terms
- **After**: Code uses taxonomy IDs in `stringVerticalFields` for filtering instead
- **Location**: `patchMarketplaceVars()` function (lines ~557-602)

### 2. Use Taxonomy IDs for Filtering
- Filters are now applied via `stringVerticalFields` with taxonomy IDs:
  ```javascript
  variables.stringVerticalFields = [
    { name: 'make', values: ['308436969822020'] },  // Honda taxonomy ID
    { name: 'model', values: ['337357940220456'] }  // Civic taxonomy ID
  ]
  ```
- This preserves chronological sorting while still filtering results

### 3. Force UI Sort Dropdown
- Added calls to `forceSortByNewest()` to ensure the UI sort dropdown is set to "Date listed: Newest first"
- This provides a fallback override if Facebook still uses relevance ranking
- **Locations**:
  - After navigation (line ~2183)
  - When make/model filters are detected (line ~2280)
  - When relevance ranking is detected (line ~2022)

### 4. Improved Detection & Warnings
- Enhanced relevance ranking detection to warn when `commerce_rank_obj.value !== 0`
- Automatically attempts to force UI sort when relevance ranking is detected
- Better logging to help diagnose future issues

### 5. Cleanup in Fallback Path
- Also removed `params.query` in the fallback patching code path (line ~388)

## Key Changes

1. **`patchMarketplaceVars()` function**:
   - Removed `params.query` injection
   - Uses taxonomy IDs in `stringVerticalFields` instead
   - Always removes `params.query` if it exists (even from Facebook's default requests)

2. **`forceSortByNewest()` function**:
   - Enhanced with multiple selector strategies for better reliability
   - More robust error handling

3. **Navigation flow**:
   - Always calls `forceSortByNewest()` after page load
   - Ensures chronological sorting even if GraphQL patching fails

## Testing Recommendations

1. **Run scraper with make/model filters**:
   ```bash
   FB_MAKE=honda FB_MODEL=civic FB_DEBUG=1 node scripts/facebook_marketplace.ts
   ```

2. **Check logs for**:
   - `[CHRONO-FIX] Using taxonomy ID for make/model filter` - confirms taxonomy IDs are used
   - `[CHRONO-FIX] Removing params.query` - confirms query removal
   - `[RANKING] ✓ Facebook using CHRONOLOGICAL sorting (value=0)` - confirms chronological mode

3. **Verify results**:
   - Results should be sorted by `posted_at` descending (newest first)
   - Check that `commerce_rank_obj.value === 0` in GraphQL responses
   - UI sort dropdown should show "Date listed: Newest first"

## Notes

- The fix preserves all existing functionality while ensuring chronological sorting
- Taxonomy IDs are already defined in `MAKE_TAXONOMY_IDS` and `MODEL_TAXONOMY_IDS` maps
- If a make/model doesn't have a taxonomy ID, the filter won't be applied (but sorting will still be chronological)
- The UI sort dropdown forcing provides a safety net if GraphQL patching fails
