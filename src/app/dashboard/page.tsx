import Link from 'next/link'

export const revalidate = 0

// Mock data for past flips
const pastFlips = [
  {
    id: '1',
    year: 2018,
    make: 'Toyota',
    model: 'Camry',
    purchasePrice: 12500,
    sellPrice: 16800,
    purchaseDate: '2024-10-15',
    sellDate: '2024-11-02',
    mileage: 78000,
    daysToSell: 18,
  },
  {
    id: '2',
    year: 2019,
    make: 'Honda',
    model: 'Accord',
    purchasePrice: 15200,
    sellPrice: 19500,
    purchaseDate: '2024-10-20',
    sellDate: '2024-11-08',
    mileage: 65000,
    daysToSell: 19,
  },
  {
    id: '3',
    year: 2017,
    make: 'Ford',
    model: 'Escape',
    purchasePrice: 11000,
    sellPrice: 14200,
    purchaseDate: '2024-09-28',
    sellDate: '2024-10-25',
    mileage: 92000,
    daysToSell: 27,
  },
  {
    id: '4',
    year: 2020,
    make: 'Mazda',
    model: 'CX-5',
    purchasePrice: 18900,
    sellPrice: 23400,
    purchaseDate: '2024-11-01',
    sellDate: '2024-11-20',
    mileage: 45000,
    daysToSell: 19,
  },
  {
    id: '5',
    year: 2016,
    make: 'Nissan',
    model: 'Altima',
    purchasePrice: 9800,
    sellPrice: 12500,
    purchaseDate: '2024-10-05',
    sellDate: '2024-10-30',
    mileage: 105000,
    daysToSell: 25,
  },
]

export default function DashboardPage() {
  const totalProfit = pastFlips.reduce((sum, flip) => sum + (flip.sellPrice - flip.purchasePrice), 0)
  const avgProfit = totalProfit / pastFlips.length
  const avgDaysToSell = pastFlips.reduce((sum, flip) => sum + flip.daysToSell, 0) / pastFlips.length

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200 pb-20">
      {/* HEADER */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-950/70 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight text-neutral-100 flex items-center gap-2">
            Saifnesse <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded">BETA</span>
          </Link>
          <nav className="hidden md:flex items-center gap-1 text-sm">
            <Link href="/" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Listings</Link>
            <Link href="/offerup" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Searches</Link>
            <Link href="/dashboard" className="rounded-md px-3 py-1.5 bg-white/5 text-white font-medium">Dashboard</Link>
            <Link href="/admin" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Admin</Link>
          </nav>
          <div className="md:hidden text-sm text-neutral-400">Menu</div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 space-y-8">
        {/* Page Title */}
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-neutral-400 mt-1">Overview of your dealership performance</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
            <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider mb-1">Total Flips</div>
            <div className="text-3xl font-bold text-white">{pastFlips.length}</div>
            <div className="text-xs text-neutral-400 mt-1">Last 30 days</div>
          </div>

          <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
            <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider mb-1">Total Profit</div>
            <div className="text-3xl font-bold text-emerald-400">${totalProfit.toLocaleString()}</div>
            <div className="text-xs text-neutral-400 mt-1">Avg: ${avgProfit.toLocaleString()} per flip</div>
          </div>

          <div className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
            <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider mb-1">Avg Days to Sell</div>
            <div className="text-3xl font-bold text-blue-400">{avgDaysToSell.toFixed(1)}</div>
            <div className="text-xs text-neutral-400 mt-1">Turnover rate</div>
          </div>
        </div>

        {/* Past Flips Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Past Flips</h2>
            <div className="text-xs text-neutral-400">{pastFlips.length} completed deals</div>
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block overflow-auto rounded-xl ring-1 ring-white/10 bg-neutral-900/20">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-950/50 text-left text-neutral-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="py-3 pl-4 pr-2">Vehicle</th>
                  <th className="py-3 pr-2">Purchase</th>
                  <th className="py-3 pr-2">Sold For</th>
                  <th className="py-3 pr-2">Profit</th>
                  <th className="py-3 pr-2">Days</th>
                  <th className="py-3 pr-2">Dates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {pastFlips.map((flip) => {
                  const profit = flip.sellPrice - flip.purchasePrice
                  const profitMargin = ((profit / flip.purchasePrice) * 100).toFixed(1)

                  return (
                    <tr key={flip.id} className="group hover:bg-white/5 transition">
                      <td className="py-3 pl-4 pr-2 font-medium text-neutral-200">
                        {flip.year} {flip.make} {flip.model}
                        <div className="text-xs text-neutral-500">{flip.mileage.toLocaleString()} mi</div>
                      </td>
                      <td className="py-3 pr-2 text-neutral-300 font-mono">
                        ${flip.purchasePrice.toLocaleString()}
                      </td>
                      <td className="py-3 pr-2 text-emerald-400 font-mono font-medium">
                        ${flip.sellPrice.toLocaleString()}
                      </td>
                      <td className="py-3 pr-2">
                        <div className="text-emerald-400 font-mono font-bold">
                          +${profit.toLocaleString()}
                        </div>
                        <div className="text-xs text-neutral-500">
                          {profitMargin}% margin
                        </div>
                      </td>
                      <td className="py-3 pr-2 text-neutral-400">
                        {flip.daysToSell} days
                      </td>
                      <td className="py-3 pr-2 text-xs text-neutral-500">
                        <div>{new Date(flip.purchaseDate).toLocaleDateString()}</div>
                        <div className="text-neutral-600">→ {new Date(flip.sellDate).toLocaleDateString()}</div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Cards */}
          <div className="md:hidden space-y-4">
            {pastFlips.map((flip) => {
              const profit = flip.sellPrice - flip.purchasePrice
              const profitMargin = ((profit / flip.purchasePrice) * 100).toFixed(1)

              return (
                <div key={flip.id} className="rounded-xl bg-neutral-900/50 ring-1 ring-white/10 p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-medium text-neutral-100">
                        {flip.year} {flip.make} {flip.model}
                      </h3>
                      <div className="text-xs text-neutral-500">{flip.mileage.toLocaleString()} mi</div>
                    </div>
                    <div className="text-right">
                      <div className="text-emerald-400 font-bold font-mono">
                        +${profit.toLocaleString()}
                      </div>
                      <div className="text-xs text-neutral-500">{profitMargin}% margin</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-neutral-500">Purchase</div>
                      <div className="font-mono text-neutral-300">${flip.purchasePrice.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-neutral-500">Sold For</div>
                      <div className="font-mono text-emerald-400">${flip.sellPrice.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-neutral-500">Days to Sell</div>
                      <div className="text-neutral-300">{flip.daysToSell} days</div>
                    </div>
                    <div>
                      <div className="text-neutral-500">Sold Date</div>
                      <div className="text-neutral-300">{new Date(flip.sellDate).toLocaleDateString()}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
