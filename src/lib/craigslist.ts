// lib/craigslist.ts
export function extractRemoteId(url: string): string | null {
    const m = url.match(/\/(\d+)\.html/);
    return m ? m[1] : null;
  }
  
  // naive helpers
  const vinRe = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
  
  export function parseListingHtml(html: string) {
    const price = (() => {
      const m = html.match(/<span class="price">\$?([\d,]+)/);
      return m ? parseInt(m[1].replace(/,/g, '')) : null;
    })();
  
    const city = (() => {
      const m = html.match(/\(([^)]+)\)\s*<\/small>/); // e.g. (Irvine)
      return m ? m[1] : null;
    })();
  
    const mileage = (() => {
      const m = html.match(/odometer:\s*<\/b>\s*([\d,]+)/i);
      return m ? parseInt(m[1].replace(/,/g, '')) : null;
    })();
  
    const titleStatus = (() => {
      const m = html.match(/title status:\s*<\/b>\s*([a-z]+)/i);
      return m ? m[1].toLowerCase() : null;
    })();
  
    const vin = (() => {
      const m = html.match(vinRe);
      return m ? m[0].toUpperCase() : null;
    })();
  
    // crude title extraction for year/make/model
    const title = (() => {
      const m = html.match(/<span id="titletextonly">([^<]+)/);
      return m ? m[1].trim() : null;
    })();
  
    let year: number | null = null;
    let make: string | null = null;
    let model: string | null = null;
  
    if (title) {
      const ym = title.match(/\b(19|20)\d{2}\b/);
      if (ym) year = parseInt(ym[0]);
      const parts = title.replace(/\b(19|20)\d{2}\b/, '').trim().split(/\s+/);
      if (parts.length >= 1) make = parts[0];
      if (parts.length >= 2) model = parts.slice(1).join(' ');
    }
  
    return { price, city, mileage, titleStatus, vin, year, make, model, title };
  }
  