// Robust Craigslist helpers (regex only)

export function extractRemoteId(url: string): string | null {
  if (!url) return null
  const m = url.match(/\/(\d+)\.html(?:[?#].*)?$/)
  return m ? m[1] : null
}

export function parseListingHtml(html: string) {
  if (!html) return {
    price: null,
    city: null,
    mileage: null,
    titleStatus: null,
    vin: null,
    year: null,
    make: null,
    model: null,
    title: null,
  }

  const priceMatch = html.match(/<span[^>]*class=['"]price['"][^>]*>\s*\$?([\d,.]+)/i)
  const price = priceMatch ? toNumber(priceMatch[1]) : null

  const cityMatch = html.match(/<small>\s*\(([^<)]+)\)\s*<\/small>/i)
  const city = cityMatch ? cityMatch[1].trim() : null

  const odoMatch = html.match(/odometer:<\/b>\s*([\d,.]+)/i)
  const mileage = odoMatch ? toNumber(odoMatch[1]) : null

  const tsMatch = html.match(/title\s*status:<\/b>\s*([a-zA-Z]+)/i)
  const titleStatus = tsMatch ? tsMatch[1].toLowerCase() : null

  const vinMatch = html.match(/\b[A-HJ-NPR-Z0-9]{17}\b/)
  const vin = vinMatch ? vinMatch[0].toUpperCase() : null

  const titleMatch = html.match(/<span[^>]*id=['"]titletextonly['"][^>]*>([^<]+)<\/span>/i)
  const title = titleMatch ? titleMatch[1].trim() : null

  let year: number | null = null
  let make: string | null = null
  let model: string | null = null
  if (title) {
    const m = title.match(/^\s*(19|20)\d{2}\s+([A-Za-z][\w-]+)\s+(.+)$/)
    if (m) {
      year = parseInt(title.slice(0, 4), 10)
      make = capitalize(m[2])
      model = m[3].trim()
    }
  }

  return { price, city, mileage, titleStatus, vin, year, make, model, title }
}

function toNumber(s: string): number | null {
  const n = parseInt(s.replace(/[^\d]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

function capitalize(s: string) { return s ? s[0].toUpperCase() + s.slice(1) : s }

