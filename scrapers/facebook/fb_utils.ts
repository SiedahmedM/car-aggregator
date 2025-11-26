// Facebook scraper utilities: year picking, posted_at extraction, sanitize

export function sanitize(s: string): string {
  if (!s) return s
  return s
    .replace(/(fb_dtsg|lsd|jazoest|__user|__a|__req|__csr|dpr|spin_r|spin_b|spin_t)=([^&\n]+)/gi, '$1=[REDACTED]')
    .replace(/"fb_dtsg"\s*:\s*"[^"]+"/gi, '"fb_dtsg":"[REDACTED]"')
    .replace(/"lsd"\s*:\s*"[^"]+"/gi, '"lsd":"[REDACTED]"')
    .replace(/[A-Fa-f0-9]{20,}/g, '[HEX]')
}

export function pickBestYearFromText(
  text: string,
  make?: string | null,
  model?: string | null,
  minYear: number = 1995,
): number | null {
  if (!text) return null

  const matches = Array.from(text.matchAll(/\b(19[5-9]\d|20[0-3]\d)\b/g))
  if (!matches.length) return null

  const candidates = matches
    .map((m) => {
      const year = parseInt(m[0], 10)
      const index = (m as any).index ?? 0
      return { year, index }
    })
    .filter((c) => c.year >= 1950 && c.year <= 2030)

  if (!candidates.length) return null

  const lower = text.toLowerCase()
  const tokens = [make, model]
    .filter(Boolean)
    .map((s) => (s as string).toLowerCase())

  // 1) Prefer years near make/model tokens
  if (tokens.length) {
    let best: { year: number; score: number } | null = null

    for (const c of candidates) {
      const windowStart = Math.max(0, c.index - 40)
      const windowEnd = Math.min(lower.length, c.index + 40)
      const window = lower.slice(windowStart, windowEnd)

      let score = 0
      for (const t of tokens) {
        if (window.includes(t)) score += 10
      }
      // Slightly favor newer years
      score += c.year / 1000

      if (!best || score > best.score) {
        best = { year: c.year, score }
      }
    }

    // Require at least one token hit
    if (best && best.score >= 10) {
      return best.year
    }
  }

  // 2) Otherwise take the newest year, but ignore suspiciously old ones
  const newest = Math.max(...candidates.map((c) => c.year))
  if (newest < minYear) return null
  return newest
}

export function extractFacebookPostedAt(mainText: string): {
  timestamp: string | null
  source: 'relative' | 'absolute' | null
} {
  if (!mainText) return { timestamp: null, source: null }

  const now = Date.now()
  const lower = mainText.toLowerCase()

  // Narrow to the 'listed ...' region when present
  let context = mainText
  const listedIdx = lower.indexOf('listed ')
  if (listedIdx !== -1) {
    context = mainText.slice(listedIdx, listedIdx + 200)
  } else {
    context = mainText.slice(0, 400)
  }

  // 1) Relative patterns: "5 days ago", "an hour ago", "a week ago"
  const rel = context.match(/(\d+|an|a)\s+(minute|hour|day|week|month|year)s?\s+ago/i)
  if (rel) {
    const rawNum = rel[1].toLowerCase()
    const n = rawNum === 'a' || rawNum === 'an' ? 1 : parseInt(rawNum, 10)
    const unit = rel[2].toLowerCase()

    const multipliers: Record<string, number> = {
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 7 * 86_400_000,
      month: 30 * 86_400_000,
      year: 365 * 86_400_000,
    }

    const mul = multipliers[unit]
    if (Number.isFinite(n) && mul) {
      const ts = new Date(now - n * mul)
      if (!Number.isNaN(ts.getTime())) {
        return { timestamp: ts.toISOString(), source: 'relative' }
      }
    }
  }

  // 2) Absolute date patterns like "January 3 at 4:15 PM" or "Jan 3, 2025"
  const abs = context.match(/(?:on\s+)?([A-Z][a-z]+ \d{1,2}(?:, \d{4})?(?: at \d{1,2}:\d{2}\s*(?:AM|PM))?)/)
  if (abs) {
    const dt = new Date(abs[1])
    if (!Number.isNaN(dt.getTime())) {
      return { timestamp: dt.toISOString(), source: 'absolute' }
    }
  }

  return { timestamp: null, source: null }
}

