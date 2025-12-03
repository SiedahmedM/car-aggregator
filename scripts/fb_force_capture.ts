// scripts/fb_force_capture.ts
// FIXED VERSION — Guaranteed to enter REAL VEHICLES CATEGORY

import { chromium } from "playwright";
import fs from "fs/promises";

const STORAGE = process.env.FB_STORAGE_STATE || "secrets/fb_state.json";
const DEBUG = true;

function log(...args: any[]) {
  console.log("[FB-FORCE]", ...args);
}

function matchVehicles(vars: any) {
  const arr = vars?.categoryIDArray;
  if (!Array.isArray(arr)) return false;
  return arr.includes(546583916084032);   // REAL Vehicles category
}

async function main() {
  log("Starting FIXED force-capture for Vehicles doc_id…");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    storageState: STORAGE,
    locale: "en-US",
    timezoneId: "America/Los_Angeles"
  });

  const page = await context.newPage();

  let saved = false;

  // Intercept GraphQL requests
  await context.route("**/api/graphql/**", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();

    const headers = req.headers();
    const body = req.postData() || "";
    const params = new URLSearchParams(body);
    const friendly = headers["x-fb-friendly-name"] || "";
    const docId = params.get("doc_id") || "";

    if (DEBUG) console.log("GQL:", friendly, "doc_id:", docId);

    if (!friendly.includes("Marketplace")) return route.continue();

    let vars: any = null;
    try { vars = JSON.parse(params.get("variables") || "{}"); } catch {}

    // STOP WHEN WE FIND A REAL VEHICLES CATEGORY REQUEST
    if (!saved && matchVehicles(vars)) {
      await fs.writeFile("facebook_gql_feed_req.json", JSON.stringify({
        url: req.url(),
        method: req.method(),
        headers,
        postData: body
      }, null, 2));

      log("✔ Captured VALID Vehicles pagination request!");
      log("✔ Saved → facebook_gql_feed_req.json");

      saved = true;
      await browser.close();
      process.exit(0);
    }

    return route.continue();
  });

  // STEP 1: Open Marketplace
  await page.goto("https://www.facebook.com/marketplace", {
    waitUntil: "domcontentloaded"
  });

  await page.waitForTimeout(2000);

  // STEP 2: Explicitly click "Browse all" FIRST
  log("Clicking Browse all...");
  try {
    const browse = page.getByText("Browse all", { exact: false });
    await browse.click({ timeout: 8000 });
  } catch {
    log("❌ Could not find Browse all. Marketplace UI may not be fully loaded.");
  }

  await page.waitForTimeout(2000);

  // STEP 3: Now click Vehicles (this should force category mode)
  log("Clicking Vehicles from Browse all...");
  try {
    const vehiclesBtn = page.getByText("Vehicles", { exact: true });
    await vehiclesBtn.click({ timeout: 8000 });
  } catch {
    log("❌ Could not find Vehicles link after Browse all.");
  }

  await page.waitForTimeout(3000);

  // STEP 4: Scroll to force category pagination
  log("Scrolling to trigger pagination…");
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.2);
    });
    await page.waitForTimeout(1500 + Math.random() * 500);
    if (saved) return;
  }

  log("❌ Still did not receive Vehicles feed. You may need to click Vehicles manually.");
  await browser.close();
  process.exit(1);
}

main();
