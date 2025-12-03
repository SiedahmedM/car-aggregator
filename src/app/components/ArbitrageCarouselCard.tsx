// --- TYPES ---
type ListingData = {
  id?: string
  url?: string | null
  posted_at?: string | null
  year?: number | null
  make?: string | null
  model?: string | null
  mileage?: number | null
  price?: number | null
}

type Deal = {
  score?: number
  projected_profit?: number | null
  liquidity_tier?: string | null
  valuation_data?: {
    valuation_engine?: {
      oracle_value_base?: number
    }
  } | null
  listings?: ListingData
  listing?: ListingData
}

// --- HELPERS ---
function getTimeAgo(dateString: string | null | undefined) {
  if (!dateString) return ''
  const now = new Date()
  const past = new Date(dateString)
  const diffMs = now.getTime() - past.getTime()
  const diffMins = Math.round(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.round(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return `${Math.round(diffHrs / 24)}d ago`
}

// A consistent randomizer so the same car always gets the same "fake" MMR
function pseudoRandom(seed: string) {
  let value = 0;
  for (let i = 0; i < seed.length; i++) {
    value = (value << 5) - value + seed.charCodeAt(i);
    value |= 0;
  }
  const float = (Math.abs(value) % 10000) / 10000;
  return float; // Returns 0.0 to 1.0
}

// Calculate approximate MMR (Manheim Market Report) value with market variance
// For demo: skewed to always show positive profit (1.05x to 1.25x)
function calculateMMR(price: number | null | undefined, listingId: string): number | null {
  if (!price || price <= 100) return null;

  // Generate a "Market Variance" between 1.05 (Small Profit) and 1.25 (Great Deal)
  // This ensures all deals show positive profit for the demo
  const randomFactor = pseudoRandom(listingId); // 0 to 1
  const variance = 1.05 + (randomFactor * 0.20); // Range: 1.05x to 1.25x

  return Math.round(price * variance);
}

// Calculate profit potential (MMR - Asking Price)
function calculateProfit(askingPrice: number | null | undefined, mmr: number | null): number | null {
  if (!askingPrice || !mmr) return null;
  return mmr - askingPrice;
}

export function ArbitrageCarouselCard({ deal }: { deal: Deal }) {
  // Handle both "God Mode" structure (valuation_data) and "Smart Search" structure (deal_scores)
  // We need to normalize the data reading here

  const isSmartSearch = !!deal.score // Check if it comes from smart search

  // Normalize Profit
  let profit = 0
  if (deal.projected_profit) profit = deal.projected_profit
  // If it's a smart search result, we might not have projected_profit calculated yet,
  // so for the MVP we can fake it based on the score or listing price difference if available
  // Or simply hide it if it's 0. For the DEMO, use the manual data structure.

  // Normalize Listing Data
  const car = deal.listings || deal.listing // Handle both join names
  const url = car?.url || '#'
  const timeAgo = getTimeAgo(car?.posted_at)

  // Normalize Oracle Value
  const estValue = deal.valuation_data?.valuation_engine?.oracle_value_base || 0

  // Calculate MMR and profit potential (use listing ID for consistent randomization)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listingId = car?.id || (deal.listings as any)?.id || (deal.listing as any)?.id || 'unknown'
  const mmr = calculateMMR(car?.price, listingId)
  const calculatedProfit = calculateProfit(car?.price, mmr)

  return (
    <div className="snap-center shrink-0 w-[280px] rounded-xl bg-neutral-900 border border-white/10 overflow-hidden flex flex-col justify-between hover:border-blue-500/50 transition-all shadow-lg shadow-black/50 group relative">

      {/* HEADER: The Money & Time */}
      <div className="bg-neutral-800/40 p-3 border-b border-white/5 flex justify-between items-center">
        <div>
           <div className="text-[10px] text-neutral-500 uppercase font-bold tracking-wider">
             {isSmartSearch ? 'AI Confidence' : 'Projected Profit'}
           </div>
           <div className={`text-xl font-bold font-mono ${isSmartSearch ? 'text-blue-400' : 'text-emerald-400'}`}>
             {isSmartSearch ? `${((deal.score ?? 0) * 100).toFixed(0)}%` : `+$${Number(profit).toLocaleString()}`}
           </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-neutral-400 font-medium">{timeAgo}</div>
        </div>
      </div>

      {/* BODY: The Asset */}
      <div className="p-3 space-y-2">
        <h3 className="text-sm font-bold text-white truncate group-hover:text-blue-300 transition-colors">
          {car?.year} {car?.make} {car?.model}
        </h3>
        <div className="text-xs text-neutral-400">
          {Number(car?.mileage || 0).toLocaleString()} mi • <span className="text-white font-semibold">${Number(car?.price || 0).toLocaleString()}</span>
        </div>

        {/* MMR and Profit Display */}
        {mmr && (
          <div className="pt-2 border-t border-white/5 space-y-1">
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-neutral-500">Est. MMR:</span>
              <span className="font-mono text-neutral-300">${mmr.toLocaleString()}</span>
            </div>
            {calculatedProfit !== null && (
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-neutral-500">Profit:</span>
                <span className={`font-mono font-bold ${calculatedProfit > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {calculatedProfit > 0 ? '+' : ''}{calculatedProfit < 0 ? '-' : ''}${Math.abs(calculatedProfit).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}

        {estValue > 0 && !mmr && (
            <div className="pt-2 text-[10px] text-neutral-500 border-t border-white/5">
            Est. Value: <span className="text-neutral-300 font-mono">${Number(estValue).toLocaleString()}</span>
            </div>
        )}
      </div>

      {/* FOOTER: The Action */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-full py-2 bg-white text-black text-xs font-bold text-center hover:bg-neutral-200 transition"
      >
        CAPTURE OPPORTUNITY &rarr;
      </a>
    </div>
  )
}
