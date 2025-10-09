// app/page.tsx
import { supaAdmin } from '@/lib/supabase-admin';

function Badge({ children, color }: { children: React.ReactNode; color: 'green'|'red'|'gray' }) {
  const map = { green: 'bg-green-100 text-green-800', red: 'bg-red-100 text-red-800', gray:'bg-gray-100 text-gray-800' };
  return <span className={`px-2 py-1 rounded text-xs ${map[color]}`}>{children}</span>;
}

export const revalidate = 0;

export default async function Page({ searchParams }: { searchParams?: Record<string,string> }) {
  const { data, error } = await supaAdmin
    .from('listings')
    .select('*')
    .order('first_seen_at', { ascending: false })
    .limit(200);

  if (error) return <div className="p-6 text-red-600">Error: {error.message}</div>;

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Craigslist Listings</h1>

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
