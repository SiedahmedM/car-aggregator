// src/lib/proxy.ts
// src/lib/proxy.ts
type BeeOpts = {
    accept: string;
    renderJS?: boolean;   // default from env
    waitMs?: number;      // default from env
    isRss?: boolean;      // just for clarity
  };
  
  const BEE_KEY = process.env.SCRAPINGBEE_KEY || "";
  const BEE_PREMIUM = (process.env.BEE_PREMIUM || "true").toLowerCase() === "true";
  const BEE_RENDER_JS = (process.env.BEE_RENDER_JS || "false").toLowerCase() === "true";
  const BEE_WAIT_MS_RSS = Number(process.env.BEE_WAIT_MS_RSS || "0");
  const BEE_WAIT_MS_DETAIL = Number(process.env.BEE_WAIT_MS_DETAIL || "1500");
  const BEE_COUNTRY = process.env.BEE_COUNTRY || "us";
  
  function beeUrl(targetUrl: string, opts: BeeOpts) {
    const u = new URL("https://app.scrapingbee.com/api/v1/");
    u.searchParams.set("api_key", BEE_KEY);
    u.searchParams.set("url", targetUrl);
  
    // Rendering (Craigslist doesn't need JS)
    const render = typeof opts.renderJS === "boolean" ? opts.renderJS : BEE_RENDER_JS;
    u.searchParams.set("render_js", render ? "true" : "false");
  
    // Wait (allow JS or slow pages to render)
    const waitMs =
      typeof opts.waitMs === "number"
        ? opts.waitMs
        : opts.isRss
        ? BEE_WAIT_MS_RSS
        : BEE_WAIT_MS_DETAIL;
    if (waitMs > 0) u.searchParams.set("wait", String(waitMs));
  
    // Residential proxy (Craigslist-friendly)
    if (BEE_PREMIUM) u.searchParams.set("premium_proxy", "true");
  
    // Country routing
    if (BEE_COUNTRY) u.searchParams.set("country_code", BEE_COUNTRY);
  
    // Allow all resources
    u.searchParams.set("block_resources", "false");
  
    return u.toString();
  }
  
  export async function fetchViaBee(targetUrl: string, opts: BeeOpts) {
    const finalUrl = BEE_KEY ? beeUrl(targetUrl, opts) : targetUrl;
    const res = await fetch(finalUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
        accept: opts.accept,
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
    const text = await res.text();
    return { ok: res.ok || res.status === 200, status: res.status, text };
  }
  
  