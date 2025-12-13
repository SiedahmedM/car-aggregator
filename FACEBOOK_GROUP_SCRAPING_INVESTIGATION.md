# Facebook Group Scraping Investigation

This document outlines the strategy for extending the existing Facebook Marketplace scraper to support Facebook Groups.

## Current Architecture
The existing scraper (`scripts/facebook_marketplace.ts`) works by:
1.  **Authentication**: Uses captured session cookies/storage state (`secrets/fb_state.json`).
2.  **Navigation**: Goes to `facebook.com/marketplace/category/vehicles`.
3.  **Interception**: Intercepts GraphQL requests to `api/graphql`.
4.  **Pagination**: Identifies the `CometMarketplaceCategoryContentPaginationQuery` (or similar).
5.  **Patching**: Modifies the query variables (e.g., sort order) and replays it or extracts data from the intercepted response.
6.  **Normalization**: Converts raw GraphQL edges into a standardized `ListingRow` format.

## Strategy for Groups
To scrape Groups, we can leverage the same underlying infrastructure (Playwright, Authentication, GraphQL Interception). The main differences will be:

1.  **Target URL**: `https://www.facebook.com/groups/<GROUP_ID>/`.
2.  **GraphQL Query**: Groups use different GraphQL queries for their feed. Likely candidates are:
    -   `GroupsCometFeedRegularStoriesPaginationQuery`
    -   `CometGroupFeedPaginationQuery`
    -   `GroupFeedPaginationQuery`
3.  **Data Structure**: The JSON structure of a group post is different from a Marketplace listing. We will need a new normalizer.

## Investigation Tool
A script has been created to assist in reverse-engineering the Group API: `scripts/investigate_fb_groups.ts`.

### Usage
1.  Ensure you have a valid `secrets/fb_state.json` (captured via `npm run fb:state` or similar).
2.  Run the investigation script with a target group URL:
    ```bash
    FB_GROUP_URL="https://www.facebook.com/groups/YOUR_GROUP_ID" npx tsx scripts/investigate_fb_groups.ts
    ```
3.  The script will:
    -   Navigate to the group.
    -   Scroll down to trigger feed loads.
    -   Capture all "interesting" GraphQL requests (Feed, Pagination, Stories) to `debug/groups/`.

### Output Analysis
After running the script, check the `debug/groups/` directory. Look for JSON files.
-   `*_req.json`: The request variables (inputs). Look for `doc_id` and variable structure.
-   `*_resp.json`: The response data. Look for `edges`, `node`, `story`, `comet_sections`.

## Implementation Plan (Future)
Once the correct `doc_id` and response structure are identified:

1.  **Refactoring**:
    -   Move `parseListingTitle` and `fbParseModelFromTitle` from `scripts/facebook_marketplace.ts` to `scrapers/facebook/fb_utils.ts`. This will allow the Group scraper to reuse the logic for parsing "Year Make Model" from unstructured post text.

2.  **Update Scraper**:
    -   Add a new mode or function `scrapeGroup(groupId)`.
    -   Implement `extractGroupEdgesFromBody(body)` to handle the group-specific JSON path.
    -   Implement `normalizeGroupEdge(edge)` to map group posts to the `ListingRow` schema.
    -   Note: Group posts might not have clear "Price", "Year", "Model" fields like Marketplace listings. We will rely heavily on the moved text parsing utilities.

## Next Steps
1.  Run the investigation script on a target group.
2.  Analyze the captured JSON.
3.  Map the JSON fields to our database schema.
