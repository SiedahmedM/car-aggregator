import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false }); // headful so you can click
  const ctx = await browser.newContext({
    // keep your desired UA/geo/timezone to match main script
    isMobile: true,
    geolocation: { latitude: 33.8166, longitude: -118.0373 },
    permissions: ['geolocation'],
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    viewport: { width: 430, height: 860 },
    timezoneId: 'America/Los_Angeles',
    locale: 'en-US',
  });

  const page = await ctx.newPage();
  await page.goto('https://offerup.com/location', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('👉 Manually set location to ZIP 90630 in the UI, then press Enter/Save/Apply in the site.');
  console.log('   When done, come back here and press ENTER in this terminal to save the session…');

  // wait for your confirmation in the terminal
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));

  await ctx.storageState({ path: 'offerup-state.json' });
  console.log('✅ Saved session to offerup-state.json');
  await browser.close();
  process.exit(0);
})();


