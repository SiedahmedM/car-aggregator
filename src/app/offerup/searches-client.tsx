"use client";
import { useEffect, useState } from 'react';

type Search = { id: string; name: string; params: unknown; created_at: string; date_key: string; active: boolean };
type JobResult = { inserted?: number; skipped?: number; errors?: unknown };
type Job = { id: string; search_id: string; status: string; created_at: string; started_at?: string; finished_at?: string; result?: JobResult; error?: string };

export default function SearchesClient({ initialSearches, initialJobs }: { initialSearches: Search[]; initialJobs: Job[] }) {
  const [searches, setSearches] = useState<Search[]>(initialSearches);
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [busy, setBusy] = useState(false);

  async function refreshSearches() {
    try {
      const res = await fetch('/api/offerup/searches', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setSearches(data);
    } catch {}
  }

  async function refreshJobs() {
    try {
      const res = await fetch('/api/offerup/jobs', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setJobs(data);
    } catch {}
  }

  useEffect(() => {
    const id = setInterval(refreshJobs, 5000);
    return () => clearInterval(id);
  }, []);

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    try {
      const fd = new FormData(form);
      const body = {
        name: String(fd.get('name') || 'Search'),
        params: {
          minYear: parseInt(String(fd.get('minYear') || '')) || undefined,
          maxYear: parseInt(String(fd.get('maxYear') || '')) || undefined,
          models: String(fd.get('models') || '').split(',').map(s => s.trim()).filter(Boolean),
          minPrice: parseInt(String(fd.get('minPrice') || '')) || undefined,
          maxPrice: parseInt(String(fd.get('maxPrice') || '')) || undefined,
          postedWithinHours: parseInt(String(fd.get('postedWithinHours') || '')) || undefined,
          radius: parseInt(String(fd.get('radius') || '')) || undefined,
        },
      };
      const res = await fetch('/api/offerup/searches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        await refreshSearches();
        form.reset();
      }
    } finally { setBusy(false); }
  }

  async function runAll() {
    setBusy(true);
    try {
      await fetch('/api/offerup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      await refreshJobs();
    } finally { setBusy(false); }
  }

  async function runOne(id: string) {
    setBusy(true);
    try {
      await fetch('/api/offerup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchIds: [id] }) });
      await refreshJobs();
    } finally { setBusy(false); }
  }

  async function cancelJob(id: string) {
    setBusy(true);
    try {
      await fetch('/api/offerup/jobs/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobIds: [id] }) });
      await refreshJobs();
    } finally { setBusy(false); }
  }

  function formatErrors(value: unknown, status: string): string {
    if (value == null) return status === 'error' ? '1+' : '-';
    if (Array.isArray(value)) return String(value.length);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return '-';
  }

  return (
    <div>
      <form className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-3" onSubmit={onSave}>
        <input name="name" placeholder="Name (e.g. 2012-2017 Camry)" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <input name="minYear" type="number" placeholder="Min Year" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <input name="maxYear" type="number" placeholder="Max Year" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <input name="models" placeholder="Models (comma)" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <input name="minPrice" type="number" placeholder="Min Price" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <input name="maxPrice" type="number" placeholder="Max Price" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <input name="postedWithinHours" type="number" placeholder="Posted within hours (e.g. 24)" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <input name="radius" type="number" placeholder="Radius miles (opt)" className="rounded bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
        <button disabled={busy} className="rounded bg-green-600 hover:bg-green-500 px-3 py-2 text-sm text-white">{busy ? 'Saving…' : 'Save Search'}</button>
      </form>

      <div className="mb-4 flex gap-2">
        <button onClick={runAll} disabled={busy} className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-2 text-sm text-white">{busy ? 'Queuing…' : 'Run All (today or fallback)'}</button>
      </div>

      <div className="space-y-3">
        {searches.map((s) => (
          <div key={s.id} className="border border-neutral-800 rounded p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-neutral-400">{JSON.stringify(s.params)}</div>
              </div>
              <button onClick={() => runOne(s.id)} disabled={busy} className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-2 text-sm text-white">Run Now</button>
            </div>
          </div>
        ))}
        {!searches.length && (
          <div className="text-sm text-neutral-400">No searches for today. Running will fallback to last saved day.</div>
        )}
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-medium mb-2">Recent Jobs</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-neutral-400">
                <th className="py-2 pr-3">Created</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Inserted</th>
                <th className="py-2 pr-3">Skipped</th>
                <th className="py-2 pr-3">Errors</th>
                <th className="py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <tr key={j.id} className="border-t border-neutral-800">
                  <td className="py-2 pr-3">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="py-2 pr-3">{j.status}</td>
                  <td className="py-2 pr-3">{j.result?.inserted ?? '-'}</td>
                  <td className="py-2 pr-3">{j.result?.skipped ?? '-'}</td>
                  <td className="py-2 pr-3">{formatErrors(j.result?.errors, j.status)}</td>
                  <td className="py-2 pr-3">
                    {(j.status === 'running' || j.status === 'pending') && (
                      <button onClick={() => cancelJob(j.id)} disabled={busy} className="rounded bg-red-600 hover:bg-red-500 px-2 py-1 text-xs text-white">Stop</button>
                    )}
                  </td>
                </tr>
              ))}
              {!jobs.length && (
                <tr><td className="py-2 text-neutral-400" colSpan={5}>No jobs yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
