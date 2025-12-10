"use client"
import { useEffect, useMemo, useState } from 'react'

type Params = {
  minYear?: number
  maxYear?: number
  makes?: string[]
  models?: string[]
  minMileage?: number
  maxMileage?: number
  minPrice?: number
  maxPrice?: number
  postedWithinHours?: number
  radius?: number
  multiRegion?: number
  regionCount?: number
}

type Search = { id: string; name: string; params: Params; created_at: string; date_key: string; active: boolean }
type JobResult = { inserted?: number; skipped?: number; errors?: unknown; log?: string }
type Job = { id: string; search_id: string; status: string; created_at: string; started_at?: string; finished_at?: string; result?: JobResult; error?: string }

// Preset configurations for common searches
const PRESETS = [
  {
    name: "2018+ Tacomas $30k-$80k",
    makes: ["toyota"],
    models: ["tacoma"],
    minYear: 2018,
    maxYear: 2025,
    minPrice: 30000,
    maxPrice: 80000,
    maxMileage: 90000
  },
  {
    name: "Budget Reliable 2012-2017",
    makes: ["toyota", "honda"],
    models: ["camry", "accord", "corolla", "civic"],
    minYear: 2012,
    maxYear: 2017,
    maxPrice: 15000,
    maxMileage: 150000
  },
  {
    name: "New Tacomas Premium",
    makes: ["toyota"],
    models: ["tacoma"],
    minYear: 2020,
    minPrice: 35000,
    maxMileage: 50000
  },
]

// UI primitives
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-neutral-900/60 ring-1 ring-white/10 ${className}`}>{children}</div>
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <div className="text-sm font-medium text-neutral-100">{title}</div>
      {subtitle ? <div className="text-xs text-neutral-400">{subtitle}</div> : null}
    </div>
  )
}

function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'info' }) {
  const map: Record<string, string> = {
    neutral: 'bg-white/5 text-neutral-300 ring-1 ring-white/10',
    success: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    danger: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
    info: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30',
  }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${map[tone]}`}>{children}</span>
}

function StatusIcon({ status }: { status: string }) {
  const tone = status === 'running' ? 'text-blue-300' : status === 'success' ? 'text-emerald-300' : status === 'error' ? 'text-rose-300' : 'text-neutral-400'
  return (
    <svg className={`h-4 w-4 ${tone}`} viewBox="0 0 24 24" fill="none">
      {status === 'running' ? (
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" className="opacity-60">
          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
        </circle>
      ) : (
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  )
}

function ProgressBar({ active }: { active: boolean }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-white/10">
      <div className={`h-full bg-blue-500 ${active ? 'animate-[progress_1.2s_linear_infinite]' : ''}`} style={{ width: '40%' }} />
      <style jsx>{`
        @keyframes progress { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
      `}</style>
    </div>
  )
}

export default function SearchesClient({ initialSearches, initialJobs }: { initialSearches: Search[]; initialJobs: Job[] }) {
  const [searches, setSearches] = useState<Search[]>(initialSearches)
  const [jobs, setJobs] = useState<Job[]>(initialJobs)
  const [busy, setBusy] = useState(false)
  const [mainTab, setMainTab] = useState<'live' | 'smart'>('live')
  const [subTab, setSubTab] = useState<'searches' | 'jobs'>('searches')
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  // Smart Search (KNN) state
  const [knnFlips, setKnnFlips] = useState<Array<{ year: number; mileage: number; bought_for: number }>>([
    { year: 0, mileage: 0, bought_for: 0 },
    { year: 0, mileage: 0, bought_for: 0 },
    { year: 0, mileage: 0, bought_for: 0 }
  ])
  const [knnMake, setKnnMake] = useState('')
  const [knnModel, setKnnModel] = useState('')

  const runningJobs = useMemo(() => jobs.filter((j) => j.status === 'running' || j.status === 'pending'), [jobs])

  // Show toast notification
  function showToast(message: string, type: 'success' | 'error' = 'success') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 5000)
  }

  // Data refreshers
  async function refreshSearches() {
    try {
      const res = await fetch('/api/offerup/searches', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setSearches(data)
    } catch {}
  }

  async function refreshJobs() {
    try {
      const res = await fetch('/api/offerup/jobs', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setJobs(data)
    } catch {}
  }

  useEffect(() => {
    const id = setInterval(refreshJobs, 5000)
    return () => clearInterval(id)
  }, [])

  // Load preset into form
  function loadPreset(preset: typeof PRESETS[0]) {
    const form = document.querySelector('form') as HTMLFormElement
    if (!form) return;
    (form.querySelector('[name="name"]') as HTMLInputElement).value = preset.name;
    (form.querySelector('[name="makes"]') as HTMLInputElement).value = preset.makes?.join(', ') || '';
    (form.querySelector('[name="models"]') as HTMLInputElement).value = preset.models?.join(', ') || '';
    (form.querySelector('[name="minYear"]') as HTMLInputElement).value = String(preset.minYear || '');
    (form.querySelector('[name="maxYear"]') as HTMLInputElement).value = String(preset.maxYear || '');
    (form.querySelector('[name="minPrice"]') as HTMLInputElement).value = String(preset.minPrice || '');
    (form.querySelector('[name="maxPrice"]') as HTMLInputElement).value = String(preset.maxPrice || '');
    (form.querySelector('[name="maxMileage"]') as HTMLInputElement).value = String(preset.maxMileage || '');
    showToast(`Loaded preset: ${preset.name}`)
  }

  // Form handlers
  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    
    // Validation
    const minYear = parseInt(String(fd.get('minYear') || ''))
    const maxYear = parseInt(String(fd.get('maxYear') || ''))
    const minPrice = parseInt(String(fd.get('minPrice') || ''))
    const maxPrice = parseInt(String(fd.get('maxPrice') || ''))
    const minMileage = parseInt(String(fd.get('minMileage') || ''))
    const maxMileage = parseInt(String(fd.get('maxMileage') || ''))
    
    if (minYear && maxYear && minYear > maxYear) {
      showToast('Min year cannot be greater than max year', 'error')
      return
    }
    if (minPrice && maxPrice && minPrice > maxPrice) {
      showToast('Min price cannot be greater than max price', 'error')
      return
    }
    if (minMileage && maxMileage && minMileage > maxMileage) {
      showToast('Min mileage cannot be greater than max mileage', 'error')
      return
    }

    setBusy(true)
    try {
      const body = {
        name: String(fd.get('name') || 'Search'),
        params: {
          minYear: parseInt(String(fd.get('minYear') || '')) || undefined,
          maxYear: parseInt(String(fd.get('maxYear') || '')) || undefined,
          makes: String(fd.get('makes') || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          models: String(fd.get('models') || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          minMileage: parseInt(String(fd.get('minMileage') || '')) || undefined,
          maxMileage: parseInt(String(fd.get('maxMileage') || '')) || undefined,
          minPrice: parseInt(String(fd.get('minPrice') || '')) || undefined,
          maxPrice: parseInt(String(fd.get('maxPrice') || '')) || undefined,
          postedWithinHours: parseInt(String(fd.get('postedWithinHours') || '')) || undefined,
          radius: parseInt(String(fd.get('radius') || '')) || undefined,
          multiRegion: String(fd.get('multiRegion') || '') === '1' ? 1 : undefined,
          regionCount: parseInt(String(fd.get('regionCount') || '')) || undefined,
        },
      }
      const res = await fetch('/api/offerup/searches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        await refreshSearches()
        form.reset()
        showToast('Search saved successfully!')
      } else {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        showToast(err.error || 'Failed to save search', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  async function runAll() {
    setBusy(true)
    try {
      await fetch('/api/offerup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
      await refreshJobs()
      showToast('All searches queued successfully!')
    } catch {
      showToast('Failed to queue searches', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function runOne(id: string) {
    setBusy(true)
    try {
      await fetch('/api/offerup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchIds: [id] }) })
      await refreshJobs()
      showToast('Search queued successfully!')
    } finally {
      setBusy(false)
    }
  }

  async function runOneDirect(id: string) {
    setBusy(true)
    try {
      const res = await fetch('/api/offerup/run/direct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchIds: [id] }) })
      if (res.ok) {
        const json = await res.json().catch(() => null)
        if (json && json.ok) {
          showToast(`Direct run completed: ${json.inserted || 0} inserted, ${json.skipped || 0} skipped`)
        } else {
          showToast('Direct run completed with errors', 'error')
        }
      } else {
        showToast('Direct run failed to start', 'error')
      }
      await refreshJobs()
    } finally {
      setBusy(false)
    }
  }

  async function cancelJob(id: string) {
    setBusy(true)
    try {
      await fetch('/api/offerup/jobs/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobIds: [id] }) })
      await refreshJobs()
      showToast('Job cancelled')
    } finally {
      setBusy(false)
    }
  }

  async function deleteJob(id: string) {
    if (!confirm('Delete this job? This action cannot be undone.')) return
    setBusy(true)
    try {
      const res = await fetch('/api/offerup/jobs/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobIds: [id] })
      })
      if (res.ok) {
        setJobs(prev => prev.filter(j => j.id !== id))
        showToast('Job deleted successfully')
      } else {
        showToast('Failed to delete job', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  async function deleteCompletedJobs() {
    const completedIds = jobs.filter(j => j.status === 'success' || j.status === 'error').map(j => j.id)
    if (!completedIds.length) {
      showToast('No completed jobs to delete', 'error')
      return
    }
    if (!confirm(`Delete ${completedIds.length} completed job(s)? This action cannot be undone.`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/offerup/jobs/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobIds: completedIds })
      })
      if (res.ok) {
        setJobs(prev => prev.filter(j => !completedIds.includes(j.id)))
        showToast(`Deleted ${completedIds.length} completed jobs`)
      } else {
        showToast('Failed to delete jobs', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  function formatErrors(value: unknown, status: string): string {
    if (value == null) return status === 'error' ? '1+' : '-'
    if (Array.isArray(value)) return String(value.length)
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    return '-'
  }

  // KNN handlers
  function addKnnRow() {
    setKnnFlips([...knnFlips, { year: 0, mileage: 0, bought_for: 0 }])
  }

  function updateKnnFlip(index: number, field: 'year' | 'mileage' | 'bought_for', value: number) {
    const updated = [...knnFlips]
    updated[index][field] = value
    setKnnFlips(updated)
  }

  async function runKnnSearch() {
    // Validate
    if (!knnMake.trim() || !knnModel.trim()) {
      showToast('Please enter make and model', 'error')
      return
    }
    const validFlips = knnFlips.filter(f => f.year > 0 && f.mileage > 0 && f.bought_for > 0)
    if (validFlips.length < 3) {
      showToast('Please enter at least 3 reference cars', 'error')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/deal-finder/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          make: knnMake.trim().toLowerCase(),
          model: knnModel.trim().toLowerCase(),
          wins: validFlips.map(f => ({
            year: f.year,
            mileage: f.mileage,
            purchasePrice: f.bought_for
          })),
          sources: ['offerup'],
          runNow: true
        })
      })
      if (res.ok) {
        showToast('Smart search started! Check results in the Analytics page.', 'success')
      } else {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        showToast(err.error || 'Failed to start search', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const totalInserted = jobs.reduce((acc, j) => acc + (j.result?.inserted || 0), 0)
  const activeToday = searches.filter((s) => s.active).length

  return (
    <div className="text-neutral-200 space-y-6">
      {/* Toast notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg ${toast.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'} text-white animate-in slide-in-from-top`}>
          {toast.message}
        </div>
      )}

      {/* Summary widgets */}
      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="text-xs text-neutral-400">Active searches</div>
          <div className="mt-1 text-2xl font-semibold">{activeToday}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-neutral-400">Recent jobs</div>
          <div className="mt-1 text-2xl font-semibold">{jobs.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-neutral-400">Running</div>
          <div className="mt-1 flex items-center gap-2 text-2xl font-semibold">
            <StatusIcon status={runningJobs.length ? 'running' : 'idle'} />
            {runningJobs.length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-neutral-400">Inserted today</div>
          <div className="mt-1 text-2xl font-semibold">{totalInserted}</div>
        </Card>
      </div>

      {/* Main Tab Switcher */}
      <Card>
        <div className="border-b border-white/10 px-4 pt-4 pb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Search Tools</h2>
            <div className="flex-1" />
            <div className="inline-flex rounded-lg bg-white/5 p-1 ring-1 ring-white/10">
              <button
                className={`px-4 py-2 text-sm font-medium rounded-md transition ${mainTab === 'live' ? 'bg-blue-600 text-white shadow-lg' : 'text-neutral-300 hover:text-white'}`}
                onClick={() => setMainTab('live')}
              >
                Live Market Search
              </button>
              <button
                className={`px-4 py-2 text-sm font-medium rounded-md transition ${mainTab === 'smart' ? 'bg-emerald-600 text-white shadow-lg' : 'text-neutral-300 hover:text-white'}`}
                onClick={() => setMainTab('smart')}
              >
                Smart Search
              </button>
            </div>
          </div>
        </div>

        {/* LIVE MARKET SEARCH TAB */}
        {mainTab === 'live' && (
          <>
            {/* Sub-tabs for Live Market Search */}
            <div className="border-b border-white/10 px-4">
              <div className="inline-flex rounded-lg bg-white/5 p-1">
                <button
                  className={`px-3 py-1.5 text-sm rounded-md transition ${subTab === 'searches' ? 'bg-neutral-900 text-white' : 'text-neutral-300 hover:text-white'}`}
                  onClick={() => setSubTab('searches')}
                >
                  Saved Searches
                </button>
                <button
                  className={`px-3 py-1.5 text-sm rounded-md transition ${subTab === 'jobs' ? 'bg-neutral-900 text-white' : 'text-neutral-300 hover:text-white'}`}
                  onClick={() => setSubTab('jobs')}
                >
                  Jobs
                </button>
              </div>
            </div>

            {subTab === 'searches' && (
              <div className="p-4">
                <SectionTitle title="Create a saved search" subtitle="Configure filters for automated OfferUp scraping" />
            
            {/* Preset buttons */}
            <div className="mb-4 flex flex-wrap gap-2">
              <span className="text-xs text-neutral-400 self-center">Quick presets:</span>
              {PRESETS.map((preset, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => loadPreset(preset)}
                  className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-700"
                >
                  {preset.name}
                </button>
              ))}
            </div>

            <form onSubmit={onSave} className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <label className="mb-1 block text-xs text-neutral-400">Name</label>
                <input name="name" placeholder="e.g. 2012–2017 Camry" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-neutral-400">Min Year</label>
                <input name="minYear" type="number" placeholder="2012" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-neutral-400">Max Year</label>
                <input name="maxYear" type="number" placeholder="2017" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-4">
                <label className="mb-1 block text-xs text-neutral-400">Makes (comma-separated)</label>
                <input name="makes" placeholder="Toyota, Honda" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-4">
                <label className="mb-1 block text-xs text-neutral-400">Models (comma-separated)</label>
                <input name="models" placeholder="Camry, Accord" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-neutral-400">Min Mileage</label>
                <input name="minMileage" type="number" placeholder="0" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-neutral-400">Max Mileage</label>
                <input name="maxMileage" type="number" placeholder="120000" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-neutral-400">Min Price</label>
                <input name="minPrice" type="number" placeholder="2500" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-neutral-400">Max Price</label>
                <input name="maxPrice" type="number" placeholder="14000" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-3">
                <label className="mb-1 flex items-center gap-1 text-xs text-neutral-400">
                  Posted within (hours)
                  <span className="text-[10px] text-neutral-500">• optional</span>
                </label>
                <input name="postedWithinHours" type="number" placeholder="Leave empty for all" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
                <div className="mt-1 text-[10px] text-neutral-500">
                  Tip: Empty = fast scraping (30s). Set 168 (1 week) for recent only.
                </div>
              </div>
              <div className="md:col-span-3">
                <label className="mb-1 block text-xs text-neutral-400">Radius (miles)</label>
                <input name="radius" type="number" placeholder="35" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-3">
                <label className="mb-1 flex items-center gap-1 text-xs text-neutral-400">
                  Multi-Region
                  <span className="text-[10px] text-neutral-500">• optional</span>
                </label>
                <select name="multiRegion" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm">
                  <option value="">Single Location</option>
                  <option value="1">Multi-Region (6 cities)</option>
                </select>
                <div className="mt-1 text-[10px] text-neutral-500">
                  Multi-region scrapes 6 cities (80 mile radius each)
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-neutral-400">Region Count</label>
                <input name="regionCount" type="number" placeholder="3" min="1" max="6" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-12 flex items-center gap-2 pt-1">
                <button disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white transition hover:bg-emerald-500 active:bg-emerald-600 disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save Search'}
                </button>
                <button type="button" onClick={runAll} disabled={busy} className="ml-auto rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition hover:bg-blue-500 active:bg-blue-600 disabled:opacity-50">
                  {busy ? 'Queuing…' : 'Run All Searches'}
                </button>
              </div>
            </form>

            {/* Saved searches list */}
            <div className="mt-6 grid grid-cols-1 gap-3">
              {searches.map((s) => {
                const filterCount = Object.values(s.params || {}).filter(v => 
                  v != null && (Array.isArray(v) ? v.length : true)
                ).length
                return (
                  <div key={s.id} className="rounded-xl border border-white/10 bg-neutral-900/40 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-neutral-100">{s.name}</div>
                          {!s.active && <Chip tone="neutral">inactive</Chip>}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {s.params?.minYear ? <Chip>≥ {s.params.minYear}</Chip> : null}
                          {s.params?.maxYear ? <Chip>≤ {s.params.maxYear}</Chip> : null}
                          {s.params?.makes && s.params.makes.length ? <Chip tone="info">{s.params.makes.slice(0, 2).join(', ')}{s.params.makes.length > 2 ? '…' : ''}</Chip> : null}
                          {s.params?.models && s.params.models.length ? <Chip tone="info">{s.params.models.slice(0, 2).join(', ')}{s.params.models.length > 2 ? '…' : ''}</Chip> : null}
                          {s.params?.minPrice ? <Chip>${s.params.minPrice.toLocaleString()}</Chip> : null}
                          {s.params?.maxPrice ? <Chip>to ${s.params.maxPrice.toLocaleString()}</Chip> : null}
                          {s.params?.maxMileage ? <Chip>≤ {s.params.maxMileage.toLocaleString()} mi</Chip> : null}
                          {s.params?.postedWithinHours ? <Chip tone="info">{s.params.postedWithinHours}h</Chip> : null}
                          {s.params?.radius ? <Chip>{s.params.radius}mi radius</Chip> : null}
                          <span className="text-[10px] text-neutral-500">{filterCount} filters</span>
                        </div>
                      </div>
                      <div className="shrink-0">
                        <div className="flex items-center gap-2">
                          <button onClick={() => runOne(s.id)} disabled={busy} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition hover:bg-blue-500 active:bg-blue-600 disabled:opacity-50">
                            Run now
                          </button>
                          <button onClick={() => runOneDirect(s.id)} disabled={busy} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-200 transition hover:bg-neutral-700 active:bg-neutral-800 disabled:opacity-50">
                            Run direct
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
              {!searches.length && (
                <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-neutral-400">
                  No searches saved for today. Create one above or run all to use last saved day&#39;s searches.
                </div>
              )}
            </div>
          </div>
            )}

            {/* Jobs sub-tab */}
            {subTab === 'jobs' && (
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <SectionTitle title="Job History" subtitle="Monitor scrape runs and manage job history" />
              <button
                onClick={deleteCompletedJobs}
                disabled={busy || !jobs.some(j => j.status === 'success' || j.status === 'error')}
                className="rounded-lg bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Clear Completed
              </button>
            </div>
            <div className="space-y-3">
              {jobs.map((j) => {
                const duration = j.finished_at && j.started_at
                  ? `${Math.round((new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000)}s`
                  : '-'
                const statusTone = j.status === 'success' ? 'success' : j.status === 'error' ? 'danger' : j.status === 'running' ? 'info' : 'neutral'

                return (
                  <div key={j.id} className="rounded-xl border border-white/10 bg-neutral-900/40 p-4 hover:bg-neutral-900/60 transition">
                    {/* Header Row */}
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div className="flex items-start gap-3 flex-1">
                        <div className="pt-0.5">
                          <StatusIcon status={j.status} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="text-sm font-medium text-neutral-100">
                              {new Date(j.created_at).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </div>
                            <Chip tone={statusTone}>{j.status.toUpperCase()}</Chip>
                          </div>

                          {/* Stats Grid */}
                          <div className="grid grid-cols-4 gap-3 text-xs mt-2">
                            <div>
                              <div className="text-neutral-500 text-[10px] uppercase">Inserted</div>
                              <div className="text-emerald-300 font-semibold font-mono">{j.result?.inserted ?? '-'}</div>
                            </div>
                            <div>
                              <div className="text-neutral-500 text-[10px] uppercase">Skipped</div>
                              <div className="text-neutral-300 font-semibold font-mono">{j.result?.skipped ?? '-'}</div>
                            </div>
                            <div>
                              <div className="text-neutral-500 text-[10px] uppercase">Errors</div>
                              <div className="text-rose-300 font-semibold font-mono">{formatErrors(j.result?.errors, j.status)}</div>
                            </div>
                            <div>
                              <div className="text-neutral-500 text-[10px] uppercase">Duration</div>
                              <div className="text-neutral-300 font-semibold font-mono">{duration}</div>
                            </div>
                          </div>

                          {/* Warning for zero results */}
                          {j.status === 'success' && (j.result?.inserted || 0) === 0 ? (
                            <div className="mt-2 text-[11px] text-rose-400 bg-rose-500/5 rounded-lg px-2 py-1.5 border border-rose-500/20">
                              No matches found. Try: widening years • removing time filters • adding more models • loosening price/mileage
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-start gap-2 shrink-0">
                        {j.result?.log && (
                          <button
                            onClick={() => setExpandedLogs((s) => ({ ...s, [j.id]: !s[j.id] }))}
                            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-neutral-700">
                            {expandedLogs[j.id] ? 'Hide Log' : 'View Log'}
                          </button>
                        )}
                        {(j.status === 'running' || j.status === 'pending') && (
                          <button
                            onClick={() => cancelJob(j.id)}
                            disabled={busy}
                            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-rose-500 disabled:opacity-50">
                            Stop
                          </button>
                        )}
                        {(j.status === 'success' || j.status === 'error') && (
                          <button
                            onClick={() => deleteJob(j.id)}
                            disabled={busy}
                            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-400 transition hover:bg-neutral-700 hover:text-rose-300 disabled:opacity-50">
                            Delete
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar for Running Jobs */}
                    {j.status === 'running' && (
                      <div className="mb-3">
                        <ProgressBar active={true} />
                      </div>
                    )}

                    {/* Expandable Log */}
                    {expandedLogs[j.id] && j.result?.log && (
                      <div className="mt-3 max-h-80 overflow-auto rounded-lg bg-black/60 p-3 text-[11px] leading-relaxed text-neutral-300 ring-1 ring-white/10">
                        <pre className="whitespace-pre-wrap">{j.result.log}</pre>
                      </div>
                    )}

                    {/* Error Details */}
                    {j.status === 'error' && j.error && (
                      <details className="mt-3 rounded-lg bg-rose-500/10 p-3 border border-rose-500/20">
                        <summary className="cursor-pointer text-xs font-medium text-rose-300">Show error details</summary>
                        <pre className="mt-2 text-[10px] text-rose-200 overflow-auto max-h-40">{j.error.slice(0, 500)}</pre>
                      </details>
                    )}
                  </div>
                )
              })}
              {!jobs.length && (
                <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
                  <div className="text-sm text-neutral-400">No jobs yet</div>
                  <div className="text-xs text-neutral-500 mt-1">Run a search to see job history here</div>
                </div>
              )}
            </div>
          </div>
            )}
          </>
        )}

        {/* SMART SEARCH (KNN) TAB */}
        {mainTab === 'smart' && (
          <div className="p-6">
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-white mb-2">Smart Search (KNN Model)</h3>
              <p className="text-sm text-neutral-400">Train the AI with your successful flips. The model will find similar deals based on your winning patterns.</p>
            </div>

            {/* Make & Model Inputs */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Make</label>
                <input
                  type="text"
                  value={knnMake}
                  onChange={(e) => setKnnMake(e.target.value)}
                  placeholder="Honda"
                  className="w-full rounded-lg bg-neutral-950 border border-white/10 px-4 py-3 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Model</label>
                <input
                  type="text"
                  value={knnModel}
                  onChange={(e) => setKnnModel(e.target.value)}
                  placeholder="Civic"
                  className="w-full rounded-lg bg-neutral-950 border border-white/10 px-4 py-3 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition"
                />
              </div>
            </div>

            {/* Reference Cars Table */}
            <div className="rounded-xl bg-neutral-900/40 border border-white/10 overflow-hidden mb-4">
              <div className="px-4 py-3 bg-neutral-950/50 border-b border-white/10">
                <h4 className="text-sm font-medium text-neutral-200">Reference Cars (Your Successful Flips)</h4>
                <p className="text-xs text-neutral-500 mt-0.5">3-5 points recommended. The more data, the smarter the search.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-950/30 text-neutral-400 text-xs uppercase tracking-wider">
                    <tr>
                      <th className="py-3 pl-4 pr-2 text-left">Year</th>
                      <th className="py-3 px-2 text-left">Mileage</th>
                      <th className="py-3 px-2 text-left">Bought for ($)</th>
                      <th className="py-3 pr-4 pl-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {knnFlips.map((flip, idx) => (
                      <tr key={idx} className="hover:bg-white/5 transition">
                        <td className="py-3 pl-4 pr-2">
                          <input
                            type="number"
                            value={flip.year || ''}
                            onChange={(e) => updateKnnFlip(idx, 'year', parseInt(e.target.value) || 0)}
                            placeholder="2018"
                            className="w-20 rounded bg-neutral-950 border border-white/10 px-2 py-1.5 text-sm focus:border-emerald-500"
                          />
                        </td>
                        <td className="py-3 px-2">
                          <input
                            type="number"
                            value={flip.mileage || ''}
                            onChange={(e) => updateKnnFlip(idx, 'mileage', parseInt(e.target.value) || 0)}
                            placeholder="30000"
                            className="w-24 rounded bg-neutral-950 border border-white/10 px-2 py-1.5 text-sm focus:border-emerald-500"
                          />
                        </td>
                        <td className="py-3 px-2">
                          <input
                            type="number"
                            value={flip.bought_for || ''}
                            onChange={(e) => updateKnnFlip(idx, 'bought_for', parseInt(e.target.value) || 0)}
                            placeholder="21000"
                            className="w-28 rounded bg-neutral-950 border border-white/10 px-2 py-1.5 text-sm focus:border-emerald-500"
                          />
                        </td>
                        <td className="py-3 pr-4 pl-2 text-right">
                          {idx >= 3 && (
                            <button
                              onClick={() => setKnnFlips(knnFlips.filter((_, i) => i !== idx))}
                              className="text-rose-400 hover:text-rose-300 text-xs"
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3">
              <button
                onClick={addKnnRow}
                className="rounded-lg bg-neutral-800 px-4 py-2.5 text-sm text-neutral-200 transition hover:bg-neutral-700"
              >
                + Add row
              </button>
              <div className="flex-1" />
              <button
                onClick={runKnnSearch}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? 'Searching...' : 'Search now'}
              </button>
            </div>

            {/* Info Box */}
            <div className="mt-6 rounded-xl bg-blue-500/10 border border-blue-500/30 p-4">
              <h5 className="text-sm font-medium text-blue-300 mb-1">How it works</h5>
              <p className="text-xs text-blue-200/70">The KNN model analyzes your successful flips and finds similar deals in the market. Results will appear in the <strong>Deal Scores</strong> section of the Analytics page, ranked by confidence score.</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
