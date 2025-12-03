// app/offerup/page.tsx
import Link from 'next/link';
import { supaAdmin } from '@/lib/supabase-admin';
import SearchesClient from './searches-client';

export const revalidate = 0;

async function getSearchesToday() {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supaAdmin
    .from('offerup_searches')
    .select('*')
    .eq('date_key', today)
    .eq('active', true)
    .order('created_at', { ascending: true });
  return data || [];
}

async function getRecentJobs(limit = 25) {
  const { data } = await supaAdmin
    .from('offerup_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// const AnalyticsClient = dynamic(() => import('../(dashboard)/analytics/page'), { ssr: false });

export default async function OfferUpPage() {
  const [searches, jobs] = await Promise.all([getSearchesToday(), getRecentJobs()]);
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-950/70 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight text-neutral-100 flex items-center gap-2">
            Saifnesse <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded">BETA</span>
          </Link>
          <nav className="hidden md:flex items-center gap-1 text-sm">
            <Link href="/" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Listings</Link>
            <Link href="/offerup" className="rounded-md px-3 py-1.5 bg-white/5 text-white font-medium">Searches</Link>
            <Link href="/dashboard" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Dashboard</Link>
            <Link href="/admin" className="rounded-md px-3 py-1.5 text-neutral-300 hover:text-white hover:bg-white/5">Admin</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6">
        <SearchesClient initialSearches={searches} initialJobs={jobs} />
      </div>
    </main>
  );
}
