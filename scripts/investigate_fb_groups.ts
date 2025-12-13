import { chromium, BrowserContext, Route } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const STORAGE_STATE = process.env.FB_STORAGE_STATE || 'secrets/fb_state.json';
const GROUP_URL = process.env.FB_GROUP_URL; // Required: e.g. https://www.facebook.com/groups/123456789
const HEADLESS = (process.env.FB_HEADLESS ?? 'true') === 'true';
const OUTPUT_DIR = 'debug/groups';

async function main() {
  if (!GROUP_URL) {
    console.error('Error: FB_GROUP_URL environment variable is required.');
    console.error('Usage: FB_GROUP_URL="https://www.facebook.com/groups/YOUR_GROUP_ID" npx tsx scripts/investigate_fb_groups.ts');
    process.exit(1);
  }

  console.log(`[GROUP-INVESTIGATION] Starting investigation for: ${GROUP_URL}`);
  
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    storageState: STORAGE_STATE,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  
  // Intercept and Log GraphQL Requests
  await context.route('**/api/graphql/**', async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();

    const postData = req.postData() || '';
    const params = new URLSearchParams(postData);
    const friendlyName = params.get('fb_api_req_friendly_name') || req.headers()['x-fb-friendly-name'] || 'Unknown';
    const docId = params.get('doc_id');
    const variables = params.get('variables');

    // Filter for likely interesting queries
    // Common keywords for feeds: "Feed", "Pagination", "Stories", "Group"
    const isInteresting = /Feed|Pagination|Stories|Group/i.test(friendlyName);

    if (isInteresting) {
      console.log(`[GQL-MATCH] Found interesting query: ${friendlyName} (doc_id: ${docId})`);
      
      const timestamp = Date.now();
      const filenameBase = `${friendlyName.replace(/[^a-z0-9]/gi, '_')}_${timestamp}`;

      // Save Request
      await fs.writeFile(
        path.join(OUTPUT_DIR, `${filenameBase}_req.json`), 
        JSON.stringify({
          url: req.url(),
          method: req.method(),
          headers: req.headers(),
          variables: variables ? JSON.parse(variables) : {},
          doc_id: docId,
          postData: postData // Save raw body too just in case
        }, null, 2)
      );

      // Save Response (we need to wait for it)
      // Note: route.continue() returns a Promise<Response> but we can't easily await the actual network response body *here* 
      // without doing more complex handling or using page.on('response').
      // So strictly here we are just capturing the REQUEST. 
      // We will capture response via page event listener.
    }

    return route.continue();
  });

  // Capture Responses separately to ensure we get the body
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('/api/graphql')) return;

    try {
      const req = resp.request();
      const postData = req.postData() || '';
      const params = new URLSearchParams(postData);
      const friendlyName = params.get('fb_api_req_friendly_name') || req.headers()['x-fb-friendly-name'];

      if (friendlyName && /Feed|Pagination|Stories|Group/i.test(friendlyName)) {
        const text = await resp.text();
        const timestamp = Date.now();
        // Try to correlate with request? For now just dump it.
        // A better way is to use the friendlyName in the filename
        const filename = `${friendlyName.replace(/[^a-z0-9]/gi, '_')}_resp_${timestamp}.json`;
        
        console.log(`[GQL-RESP] Saving response for ${friendlyName}`);
        
        let data;
        try {
          // Handle "for (;;);" prefix
          const cleanText = text.startsWith('for (;;);') ? text.slice(9) : text;
          data = JSON.parse(cleanText);
        } catch {
          data = { raw: text };
        }

        await fs.writeFile(
          path.join(OUTPUT_DIR, filename),
          JSON.stringify(data, null, 2)
        );
      }
    } catch (e) {
      console.error(`[GQL-RESP-ERROR] Failed to save response:`, e);
    }
  });

  try {
    console.log('[NAV] Navigating to group...');
    await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    console.log('[SCROLL] Starting scroll sequence to trigger pagination...');
    
    // Scroll a few times to trigger feed loading
    for (let i = 0; i < 5; i++) {
      console.log(`[SCROLL] Scroll ${i + 1}/5`);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
      await page.waitForTimeout(3000 + Math.random() * 2000);
    }

    console.log('[DONE] Finished scrolling. Check debug/groups/ for captured files.');

  } catch (e) {
    console.error('[ERROR] Runtime error:', e);
  } finally {
    await browser.close();
  }
}

main();
