// app/page.tsx
import { supaAdmin } from '@/lib/supabase-admin';
import Link from 'next/link';

function Badge({ children, color }: { children: React.ReactNode; color: 'green'|'red'|'gray' }) {
  const map = { green: 'bg-green-100 text-green-800', red: 'bg-red-100 text-red-800', gray:'bg-gray-100 text-gray-800' };
  return <span className={`px-2 py-1 rounded text-xs ${map[color]}`}>{children}</span>;
}

export const revalidate = 0;

export default async function Page({ searchParams }: { searchParams?: Record<string,string> }) {
  const sp = searchParams || {};
  const minYear = parseInt(sp.minYear || '') || 0;
  const maxYear = parseInt(sp.maxYear || '') || 0;
  const minMileage = parseInt(sp.minMileage || '') || 0;
  const maxMileage = parseInt(sp.maxMileage || '') || 0;
  const makes = (sp.makes || '').split(',').filter(Boolean);
  const cities = (sp.cities || '').split(',').filter(Boolean);
  const sources = (sp.sources || '').split(',').filter(Boolean);
  const age = sp.age || '';

  function hrefWith(updates: Record<string, string|null|undefined>) {
    const p = new URLSearchParams();
    // seed with current string params only
    for (const [k, v] of Object.entries(sp)) {
      if (typeof v === 'string' && v.length) p.set(k, v);
    }
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === '') p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    return qs ? `/?${qs}` : '/';
  }

  let query = supaAdmin
    .from('listings')
    .select('*')
    .order('first_seen_at', { ascending: false })
    .limit(200);
  if (minYear) query = query.gte('year', minYear);
  if (maxYear) query = query.lte('year', maxYear);
  if (minMileage) query = query.gte('mileage', minMileage);
  if (maxMileage) query = query.lte('mileage', maxMileage);
  if (makes.length) query = query.in('make', makes);
  if (cities.length) query = query.in('city', cities);
  if (sources.length) query = query.in('source', sources);
  if (age) {
    const now = Date.now();
    const ms = age === '30m' ? 30*60*1000
      : age === '2h' ? 2*60*60*1000
      : age === '6h' ? 6*60*60*1000
      : age === '24h' ? 24*60*60*1000
      : age === '7d' ? 7*24*60*60*1000
      : 0;
    if (ms) {
      const sinceIso = new Date(now - ms).toISOString();
      query = query.gte('posted_at', sinceIso);
    }
  }

  const { data, error } = await query;

  if (error) return <div className="p-6 text-red-600">Error: {error.message}</div>;

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Listings</h1>
      <div className="mb-3 text-sm">
        <Link href="/offerup" className="underline text-blue-400">Manage OfferUp Saved Searches →</Link>
      </div>

      {/* Filters */}
      <form className="mb-6 w-full max-w-4xl rounded-lg border border-neutral-800 bg-neutral-900/40 p-4" method="GET">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
          <div>
            <label className="block text-xs text-neutral-400 mb-1">Min Year</label>
            <input type="number" inputMode="numeric" min={1950} max={2100} placeholder="2015" name="minYear" defaultValue={sp.minYear || ''} className="w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
            <div className="flex gap-3 mt-1 text-xs text-neutral-400">
              {['2015','2018','2020'].map(v => (
                <a key={v} href={hrefWith({ minYear: v })} className="hover:text-neutral-200 underline">{v}+</a>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-neutral-400 mb-1">Max Year</label>
            <input type="number" inputMode="numeric" min={1950} max={2100} placeholder="2022" name="maxYear" defaultValue={sp.maxYear || ''} className="w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-neutral-400 mb-1">Min Mileage</label>
            <input type="number" inputMode="numeric" min={0} step={1000} placeholder="0" name="minMileage" defaultValue={sp.minMileage || ''} className="w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
            <div className="flex flex-wrap gap-3 mt-1 text-xs text-neutral-400">
              <a href={hrefWith({ maxMileage: '100000' })} className="hover:text-neutral-200 underline">Under 100k</a>
              <a href={hrefWith({ maxMileage: '75000' })} className="hover:text-neutral-200 underline">Under 75k</a>
              <a href={hrefWith({ maxMileage: '50000' })} className="hover:text-neutral-200 underline">Under 50k</a>
            </div>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-neutral-400 mb-1">Makes (comma-separated)</label>
            <input name="makes" defaultValue={sp.makes || ''} placeholder="Honda,Toyota,Nissan" className="w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
            <div className="mt-1 text-xs text-neutral-400">
              <a href={hrefWith({ makes: 'Honda,Toyota,Nissan,Mazda,Subaru,Acura,Lexus,Infiniti' })} className="hover:text-neutral-200 underline">Select Japanese brands</a>
            </div>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-neutral-400 mb-1">Cities (comma-separated)</label>
            <input name="cities" defaultValue={sp.cities || ''} className="w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-neutral-400 mb-1">Sources</label>
            <select name="sources" defaultValue={sp.sources || ''} className="w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm">
              <option value="">All</option>
              <option value="craigslist">Craigslist</option>
              <option value="offerup">OfferUp</option>
              <option value="facebook">Facebook</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-neutral-400 mb-1">Listing Age</label>
            <select name="age" defaultValue={sp.age || ''} className="w-full rounded-md bg-neutral-950 border border-neutral-700 px-3 py-2 text-sm">
              <option value="">Any time</option>
              <option value="30m">Past 30 minutes</option>
              <option value="2h">Past 2 hours</option>
              <option value="6h">Past 6 hours</option>
              <option value="24h">Past 24 hours</option>
              <option value="7d">Past 7 days</option>
            </select>
          </div>
          <div className="md:col-span-6 flex gap-2 pt-1">
            <button type="submit" className="rounded-md bg-blue-600 hover:bg-blue-500 px-3 py-2 text-sm">Apply</button>
            <Link href="/" className="rounded-md bg-neutral-800 hover:bg-neutral-700 px-3 py-2 text-sm">Reset</Link>
          </div>
        </div>
      </form>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Posted</th>
              <th className="py-2 pr-4">Title</th>
              <th className="py-2 pr-4">Price</th>
              <th className="py-2 pr-4">Mileage</th>
              <th className="py-2 pr-4">Title Status</th>
              <th className="py-2 pr-4">City</th>
              <th className="py-2 pr-4">Link</th>
            </tr>
          </thead>
          <tbody>
            {(data || []).map((r) => (
              <tr key={r.id} className="border-b hover:bg-gray-50">
                <td className="py-2 pr-4">{r.posted_at ? new Date(r.posted_at).toLocaleString() : ''}</td>
                <td className="py-2 pr-4 font-medium">
                  {r.year ? `${r.year} ` : ''}{r.make ? `${r.make} ` : ''}{r.model || r.title || ''}
                </td>
                <td className="py-2 pr-4">{r.price ? `$${r.price.toLocaleString()}` : '-'}</td>
                <td className="py-2 pr-4">{r.mileage ? `${r.mileage.toLocaleString()} mi` : '-'}</td>
                <td className="py-2 pr-4">
                  {r.title_status
                    ? <Badge color={r.title_status === 'clean' ? 'green' : (r.title_status === 'salvage' ? 'red' : 'gray')}>
                        {r.title_status}
                      </Badge>
                    : <Badge color="gray">unknown</Badge>}
                </td>
                <td className="py-2 pr-4">{r.city || '-'}</td>
                <td className="py-2 pr-4">
                  <a className="text-blue-600 underline" href={r.url} target="_blank">Open</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
