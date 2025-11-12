"use client"
import { useEffect, useMemo, useState } from 'react'

type Params = {
  minYear?: number
  maxYear?: number
  models?: string[]
  minPrice?: number
  maxPrice?: number
  postedWithinHours?: number
  radius?: number
}

type Search = { id: string; name: string; params: Params; created_at: string; date_key: string; active: boolean }
type JobResult = { inserted?: number; skipped?: number; errors?: unknown; log?: string }
type Job = { id: string; search_id: string; status: string; created_at: string; started_at?: string; finished_at?: string; result?: JobResult; error?: string }

// Small UI primitives ------------------------------------------------------
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
  const [tab, setTab] = useState<'searches' | 'jobs'>('searches')
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({})

  const runningJobs = useMemo(() => jobs.filter((j) => j.status === 'running' || j.status === 'pending'), [jobs])

  // Data refreshers --------------------------------------------------------
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

  // Form handlers (keep business logic) -----------------------------------
  // onSave: create a saved search with OfferUp params
  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    setBusy(true)
    try {
      const fd = new FormData(form)
      const body = {
        name: String(fd.get('name') || 'Search'),
        params: {
          minYear: parseInt(String(fd.get('minYear') || '')) || undefined,
          maxYear: parseInt(String(fd.get('maxYear') || '')) || undefined,
          minMileage: parseInt(String(fd.get('minMileage') || '')) || undefined,
          maxMileage: parseInt(String(fd.get('maxMileage') || '')) || undefined,
          models: String(fd.get('models') || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          minPrice: parseInt(String(fd.get('minPrice') || '')) || undefined,
          maxPrice: parseInt(String(fd.get('maxPrice') || '')) || undefined,
          postedWithinHours: parseInt(String(fd.get('postedWithinHours') || '')) || undefined,
          radius: parseInt(String(fd.get('radius') || '')) || undefined,
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
      }
    } finally {
      setBusy(false)
    }
  }

  // runAll: queue all searches for execution
  async function runAll() {
    setBusy(true)
    try {
      await fetch('/api/offerup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
      await refreshJobs()
    } finally {
      setBusy(false)
    }
  }

  // runOne: queue a single search
  async function runOne(id: string) {
    setBusy(true)
    try {
      await fetch('/api/offerup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchIds: [id] }) })
      await refreshJobs()
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
        // show a simple alert and refresh jobs (in case script inserted records)
        if (json && json.ok) {
          alert(`Direct run completed: inserted=${json.inserted || 0}, skipped=${json.skipped || 0}, errors=${json.errors || 0}`)
        } else {
          alert('Direct run failed. See console.')
        }
      } else {
        alert('Direct run failed to start.')
      }
      await refreshJobs()
    } finally {
      setBusy(false)
    }
  }

  // cancelJob: request cancellation of a running/pending job
  async function cancelJob(id: string) {
    setBusy(true)
    try {
      await fetch('/api/offerup/jobs/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobIds: [id] }) })
      await refreshJobs()
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

  // Render -----------------------------------------------------------------
  const totalInserted = jobs.reduce((acc, j) => acc + (j.result?.inserted || 0), 0)
  const activeToday = searches.filter((s) => s.active).length

  return (
    <div className="text-neutral-200">
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

      {/* Tabs */}
      <Card>
        <div className="border-b border-white/10 px-3 pt-3">
          <div className="inline-flex rounded-lg bg-white/5 p-1">
            <button
              className={`px-3 py-1.5 text-sm rounded-md transition ${tab === 'searches' ? 'bg-neutral-900 text-white' : 'text-neutral-300 hover:text-white'}`}
              onClick={(e) => {
                e.preventDefault()
                setTab('searches')
              }}
            >
              Saved Searches
            </button>
            <button
              className={`px-3 py-1.5 text-sm rounded-md transition ${tab === 'jobs' ? 'bg-neutral-900 text-white' : 'text-neutral-300 hover:text-white'}`}
              onClick={(e) => {
                e.preventDefault()
                setTab('jobs')
              }}
            >
              Jobs
            </button>
          </div>
        </div>

        {/* Saved Searches tab */}
        {tab === 'searches' && (
          <div className="p-4">
            <SectionTitle title="Create a saved search" subtitle="Guide OfferUp runs with friendly presets." />
            {/* onSave wiring below keeps existing backend contract */}
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
                <label className="mb-1 block text-xs text-neutral-400">Models</label>
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
                <label className="mb-1 block text-xs text-neutral-400">Posted within (hours)</label>
                <input name="postedWithinHours" type="number" placeholder="24" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-3">
                <label className="mb-1 block text-xs text-neutral-400">Radius (miles)</label>
                <input name="radius" type="number" placeholder="25" className="w-full rounded-lg bg-neutral-950 border border-white/10 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-12 flex items-center gap-2 pt-1">
                <button disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white transition hover:bg-emerald-500 active:bg-emerald-600">
                  {busy ? 'Saving…' : 'Save Search'}
                </button>
                <button type="button" onClick={runAll} disabled={busy} className="ml-auto rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition hover:bg-blue-500 active:bg-blue-600">
                  {busy ? 'Queuing…' : 'Run All (today or fallback)'}
                </button>
              </div>
            </form>

            {/* Saved searches list */}
            <div className="mt-6 grid grid-cols-1 gap-3">
              {searches.map((s) => (
                <div key={s.id} className="rounded-xl border border-white/10 bg-neutral-900/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-neutral-100">{s.name}</div>
                        {!s.active && <Chip tone="neutral">inactive</Chip>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {s.params?.minYear ? <Chip>≥ {s.params.minYear}</Chip> : null}
                        {s.params?.maxYear ? <Chip>≤ {s.params.maxYear}</Chip> : null}
                        {s.params?.models && s.params.models.length ? <Chip tone="info">{s.params.models.slice(0, 3).join(', ')}{s.params.models.length > 3 ? '…' : ''}</Chip> : null}
                        {s.params?.minPrice ? <Chip>${s.params.minPrice}</Chip> : null}
                        {s.params?.maxPrice ? <Chip>to ${s.params.maxPrice}</Chip> : null}
                        {s.params?.postedWithinHours ? <Chip tone="info">{s.params.postedWithinHours}h</Chip> : null}
                        {s.params?.radius ? <Chip tone="info">{s.params.radius}mi</Chip> : null}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <div className="flex items-center gap-2">
                        <button onClick={() => runOne(s.id)} disabled={busy} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition hover:bg-blue-500 active:bg-blue-600">
                          Run now
                        </button>
                        <button onClick={() => runOneDirect(s.id)} disabled={busy} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-200 transition hover:bg-neutral-700 active:bg-neutral-800">
                          Run direct
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {!searches.length && (
                <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-neutral-400">No searches for today. Running will fallback to last saved day.</div>
              )}
            </div>
          </div>
        )}

        {/* Jobs tab */}
        {tab === 'jobs' && (
          <div className="p-4">
            <SectionTitle title="Job status" subtitle="Monitor runs and stop long-running ones." />
            <div className="space-y-3">
              {jobs.map((j) => (
                <div key={j.id} className="rounded-xl border border-white/10 bg-neutral-900/40 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <StatusIcon status={j.status} />
                      <div>
                        <div className="text-sm text-neutral-100">{new Date(j.created_at).toLocaleString()}</div>
                        <div className="text-[11px] text-neutral-400">
                          status: <span className="uppercase">{j.status}</span>
                          <span className="mx-2">•</span> inserted: {j.result?.inserted ?? '-'}
                          <span className="mx-2">•</span> skipped: {j.result?.skipped ?? '-'}
                          <span className="mx-2">•</span> errors: {formatErrors(j.result?.errors, j.status)}
                        </div>
                        {j.status === 'success' && (j.result?.inserted || 0) === 0 ? (
                          <div className="mt-1 text-[11px] text-neutral-400">
                            No matches found. Try loosening your filters (years, price, models, hours).
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {j.result?.log ? (
                        <button
                          onClick={() => setExpandedLogs((s) => ({ ...s, [j.id]: !s[j.id] }))}
                          className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 transition hover:bg-neutral-700 active:bg-neutral-800">
                          {expandedLogs[j.id] ? 'Hide log' : 'View log'}
                        </button>
                      ) : null}
                      {(j.status === 'running' || j.status === 'pending') && (
                        <button onClick={() => cancelJob(j.id)} disabled={busy} className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs text-white transition hover:bg-rose-500 active:bg-rose-600">
                          Stop
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-3"><ProgressBar active={j.status === 'running'} /></div>
                  {expandedLogs[j.id] && j.result?.log ? (
                    <div className="mt-3 max-h-80 overflow-auto rounded-lg bg-black/60 p-3 text-[11px] leading-relaxed text-neutral-300 ring-1 ring-white/10">
                      <pre className="whitespace-pre-wrap">{j.result.log}</pre>
                    </div>
                  ) : null}
                </div>
              ))}
              {!jobs.length && <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-neutral-400">No jobs yet.</div>}
            </div>

            {/* Table view for larger screens */}
            <div className="mt-6 hidden md:block overflow-auto rounded-xl ring-1 ring-white/10">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 z-10 bg-neutral-950/80 backdrop-blur text-left text-neutral-400">
                  <tr>
                    <th className="py-2 pl-3 pr-4">Created</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Inserted</th>
                    <th className="py-2 pr-4">Skipped</th>
                    <th className="py-2 pr-4">Errors</th>
                    <th className="py-2 pr-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {jobs.map((j) => (
                    <tr key={j.id} className="hover:bg-white/5 transition">
                      <td className="py-2 pl-3 pr-4">{new Date(j.created_at).toLocaleString()}</td>
                      <td className="py-2 pr-4">
                        <Chip tone={j.status === 'success' ? 'success' : j.status === 'error' ? 'danger' : 'info'}>{j.status}</Chip>
                      </td>
                      <td className="py-2 pr-4">{j.result?.inserted ?? '-'}</td>
                      <td className="py-2 pr-4">{j.result?.skipped ?? '-'}</td>
                      <td className="py-2 pr-4">{formatErrors(j.result?.errors, j.status)}</td>
                      <td className="py-2 pr-3">
                        {(j.status === 'running' || j.status === 'pending') && (
                          <button onClick={() => cancelJob(j.id)} disabled={busy} className="rounded-md bg-rose-600 px-2 py-1 text-xs text-white transition hover:bg-rose-500 active:bg-rose-600">
                            Stop
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
