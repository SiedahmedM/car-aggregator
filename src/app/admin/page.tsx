'use client'

import { useState } from 'react'
import Link from 'next/link'

// Mock employee submissions
const mockSubmissions = [
  {
    id: '1',
    employeeName: 'John Smith',
    submittedAt: '2024-12-01T10:30:00Z',
    listing: {
      year: 2019,
      make: 'Toyota',
      model: 'RAV4',
      price: 16500,
      mileage: 68000,
      url: 'https://www.offerup.com/item/detail/1234',
      source: 'OfferUp',
      city: 'Los Angeles',
    },
    notes: 'Clean title, single owner, well maintained. Great deal at this price point.',
    estimatedMMR: 20250,
  },
  {
    id: '2',
    employeeName: 'Sarah Johnson',
    submittedAt: '2024-12-01T09:15:00Z',
    listing: {
      year: 2020,
      make: 'Honda',
      model: 'Civic',
      price: 14200,
      mileage: 52000,
      url: 'https://www.facebook.com/marketplace/item/5678',
      source: 'Facebook',
      city: 'Long Beach',
    },
    notes: 'Low mileage, recent service records available. Seller motivated.',
    estimatedMMR: 17220,
  },
  {
    id: '3',
    employeeName: 'Mike Chen',
    submittedAt: '2024-12-01T08:45:00Z',
    listing: {
      year: 2018,
      make: 'Ford',
      model: 'Escape',
      price: 11800,
      mileage: 85000,
      url: 'https://www.offerup.com/item/detail/9012',
      source: 'OfferUp',
      city: 'Anaheim',
    },
    notes: 'Needs minor cosmetic work but mechanically sound. Good flip potential.',
    estimatedMMR: 14350,
  },
]

// Mock past flips data (same as dashboard)
const pastFlips = [
  { id: '1', year: 2018, make: 'Toyota', model: 'Camry', purchasePrice: 12500, sellPrice: 16800, purchaseDate: '2024-10-15', sellDate: '2024-11-02', profit: 4300 },
  { id: '2', year: 2019, make: 'Honda', model: 'Accord', purchasePrice: 15200, sellPrice: 19500, purchaseDate: '2024-10-20', sellDate: '2024-11-08', profit: 4300 },
  { id: '3', year: 2017, make: 'Ford', model: 'Escape', purchasePrice: 11000, sellPrice: 14200, purchaseDate: '2024-09-28', sellDate: '2024-10-25', profit: 3200 },
  { id: '4', year: 2020, make: 'Mazda', model: 'CX-5', purchasePrice: 18900, sellPrice: 23400, purchaseDate: '2024-11-01', sellDate: '2024-11-20', profit: 4500 },
  { id: '5', year: 2016, make: 'Nissan', model: 'Altima', purchasePrice: 9800, sellPrice: 12500, purchaseDate: '2024-10-05', sellDate: '2024-10-30', profit: 2700 },
]

export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [submissions, setSubmissions] = useState(mockSubmissions)
  const [dateFilter, setDateFilter] = useState('all') // all, 7d, 30d
  const [makeFilter, setMakeFilter] = useState('')

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault()
    if (passcode === '1234') {
      setIsAuthenticated(true)
      setError('')
    } else {
      setError('Invalid passcode')
      setPasscode('')
    }
  }

  const handleAccept = async (submissionId: string) => {
    // In production, this would call the API to add to watched_listings
    setSubmissions(prev => prev.filter(s => s.id !== submissionId))
    // Show success message
    alert('Listing added to Currently Watching!')
  }

  const handleReject = (submissionId: string) => {
    setSubmissions(prev => prev.filter(s => s.id !== submissionId))
  }

  // Filter past flips for financial reports
  const getFilteredFlips = () => {
    let filtered = pastFlips

    // Date filter
    if (dateFilter === '7d') {
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
      filtered = filtered.filter(f => new Date(f.sellDate) >= sevenDaysAgo)
    } else if (dateFilter === '30d') {
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      filtered = filtered.filter(f => new Date(f.sellDate) >= thirtyDaysAgo)
    }

    // Make filter
    if (makeFilter) {
      filtered = filtered.filter(f => f.make.toLowerCase().includes(makeFilter.toLowerCase()))
    }

    return filtered
  }

  const filteredFlips = getFilteredFlips()
  const totalRevenue = filteredFlips.reduce((sum, flip) => sum + flip.sellPrice, 0)
  const totalProfit = filteredFlips.reduce((sum, flip) => sum + flip.profit, 0)
  const avgProfit = filteredFlips.length > 0 ? totalProfit / filteredFlips.length : 0

  // Login screen
  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-200 flex items-center justify-center">
        <div className="w-full max-w-md px-4">
          <div className="rounded-2xl bg-neutral-900/50 ring-1 ring-white/10 p-8">
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-600/20 ring-1 ring-blue-500/30 mb-4">
                <svg className="w-8 h-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
              <p className="text-sm text-neutral-400 mt-2">Enter passcode to continue</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <input
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Enter passcode"
                  className="w-full rounded-lg bg-neutral-950 border border-white/10 px-4 py-3 text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
                  maxLength={4}
                  autoFocus
                />
                {error && (
                  <p className="text-rose-400 text-sm mt-2 text-center">{error}</p>
                )}
                <p className="text-neutral-500 text-xs mt-2 text-center">Hint: 1234</p>
              </div>

              <button
                type="submit"
                className="w-full rounded-lg bg-blue-600 px-4 py-3 text-white font-medium hover:bg-blue-500 transition"
              >
                Unlock Dashboard
              </button>
            </form>

            <div className="mt-6 text-center">
              <Link href="/" className="text-sm text-neutral-400 hover:text-white">
                ← Back to Listings
              </Link>
            </div>
          </div>
        </div>
      </main>
    )
  }

  // Admin Dashboard
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200 pb-20">
      {/* HEADER */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-950/70 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight text-neutral-100 flex items-center gap-2">
            Car Aggregator <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded">BETA</span>
          </Link>
          <nav className="hidden md:flex items-center gap-1 text-sm">
            <Link href="/" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Listings</Link>
            <Link href="/offerup" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Searches</Link>
            <Link href="/dashboard" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Dashboard</Link>
            <Link href="/admin" className="rounded-md px-3 py-1.5 bg-white/5 text-white font-medium">Admin</Link>
          </nav>
          <button
            onClick={() => setIsAuthenticated(false)}
            className="text-sm text-neutral-400 hover:text-white"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 space-y-8">
        {/* Page Title */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
            <p className="text-sm text-neutral-400 mt-1">Manager portal for reviewing submissions and reports</p>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-emerald-600/20 ring-1 ring-emerald-500/30 text-emerald-400 text-xs font-medium">
            Authenticated
          </div>
        </div>

        {/* Employee Findings Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Employee Findings</h2>
            <div className="text-xs text-neutral-400">{submissions.length} pending reviews</div>
          </div>

          {submissions.length === 0 ? (
            <div className="rounded-xl bg-neutral-900/20 ring-1 ring-white/10 p-8 text-center">
              <div className="text-neutral-500 text-sm">No pending submissions</div>
            </div>
          ) : (
            <div className="space-y-4">
              {submissions.map((submission) => {
                const profit = submission.estimatedMMR - submission.listing.price
                const profitMargin = ((profit / submission.listing.price) * 100).toFixed(1)

                return (
                  <div key={submission.id} className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-medium text-neutral-100">
                            {submission.listing.year} {submission.listing.make} {submission.listing.model}
                          </h3>
                          <span className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-400">
                            {submission.listing.source}
                          </span>
                        </div>
                        <div className="text-xs text-neutral-500">
                          Submitted by <span className="text-neutral-400 font-medium">{submission.employeeName}</span> • {new Date(submission.submittedAt).toLocaleString()}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Asking Price:</span>
                          <span className="font-mono text-neutral-200">${submission.listing.price.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Est. MMR:</span>
                          <span className="font-mono text-neutral-300">${submission.estimatedMMR.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between border-t border-white/5 pt-2">
                          <span className="text-neutral-500">Potential Profit:</span>
                          <span className={`font-mono font-bold ${profit > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            +${profit.toLocaleString()} ({profitMargin}%)
                          </span>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Mileage:</span>
                          <span className="text-neutral-300">{submission.listing.mileage.toLocaleString()} mi</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Location:</span>
                          <span className="text-neutral-300">{submission.listing.city}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-neutral-500">Listing:</span>
                          <a href={submission.listing.url} target="_blank" rel="noopener" className="text-blue-400 hover:text-blue-300 text-xs">
                            View →
                          </a>
                        </div>
                      </div>
                    </div>

                    {submission.notes && (
                      <div className="mb-4 p-3 rounded-lg bg-neutral-950/50 border border-white/5">
                        <div className="text-xs text-neutral-500 mb-1">Employee Notes:</div>
                        <div className="text-sm text-neutral-300">{submission.notes}</div>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAccept(submission.id)}
                        className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-white text-sm font-medium transition"
                      >
                        Accept & Add to Watching
                      </button>
                      <button
                        onClick={() => handleReject(submission.id)}
                        className="flex-1 rounded-lg bg-rose-600 hover:bg-rose-500 px-4 py-2 text-white text-sm font-medium transition"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Financial Reports Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Financial Reports</h2>
          </div>

          {/* Filters */}
          <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4 mb-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Time Period</label>
                <select
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm"
                >
                  <option value="all">All Time</option>
                  <option value="7d">Last 7 Days</option>
                  <option value="30d">Last 30 Days</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">Make Filter</label>
                <input
                  type="text"
                  value={makeFilter}
                  onChange={(e) => setMakeFilter(e.target.value)}
                  placeholder="Filter by make..."
                  className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => {
                    setDateFilter('all')
                    setMakeFilter('')
                  }}
                  className="w-full rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 transition"
                >
                  Reset Filters
                </button>
              </div>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
              <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider mb-1">Total Flips</div>
              <div className="text-3xl font-bold text-white">{filteredFlips.length}</div>
            </div>

            <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
              <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider mb-1">Total Revenue</div>
              <div className="text-3xl font-bold text-blue-400">${totalRevenue.toLocaleString()}</div>
            </div>

            <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
              <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider mb-1">Total Profit</div>
              <div className="text-3xl font-bold text-emerald-400">${totalProfit.toLocaleString()}</div>
            </div>

            <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
              <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider mb-1">Avg Profit</div>
              <div className="text-3xl font-bold text-emerald-400">${avgProfit.toLocaleString()}</div>
            </div>
          </div>

          {/* Detailed Table */}
          <div className="overflow-auto rounded-xl ring-1 ring-white/10 bg-neutral-900/20">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-950/50 text-left text-neutral-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="py-3 pl-4 pr-2">Vehicle</th>
                  <th className="py-3 pr-2">Purchase</th>
                  <th className="py-3 pr-2">Sell Price</th>
                  <th className="py-3 pr-2">Profit</th>
                  <th className="py-3 pr-2">Margin</th>
                  <th className="py-3 pr-4">Date Sold</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredFlips.map((flip) => {
                  const margin = ((flip.profit / flip.purchasePrice) * 100).toFixed(1)

                  return (
                    <tr key={flip.id} className="hover:bg-white/5 transition">
                      <td className="py-3 pl-4 pr-2 font-medium text-neutral-200">
                        {flip.year} {flip.make} {flip.model}
                      </td>
                      <td className="py-3 pr-2 text-neutral-300 font-mono">
                        ${flip.purchasePrice.toLocaleString()}
                      </td>
                      <td className="py-3 pr-2 text-blue-400 font-mono">
                        ${flip.sellPrice.toLocaleString()}
                      </td>
                      <td className="py-3 pr-2 text-emerald-400 font-mono font-bold">
                        +${flip.profit.toLocaleString()}
                      </td>
                      <td className="py-3 pr-2 text-neutral-400">
                        {margin}%
                      </td>
                      <td className="py-3 pr-4 text-xs text-neutral-500">
                        {new Date(flip.sellDate).toLocaleDateString()}
                      </td>
                    </tr>
                  )
                })}
                {filteredFlips.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-sm text-neutral-500">
                      No flips match the selected filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  )
}
