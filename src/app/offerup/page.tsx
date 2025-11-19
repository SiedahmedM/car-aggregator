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
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">OfferUp Saved Searches</h1>

      <SearchesClient initialSearches={searches} initialJobs={jobs} />

      <div className="mt-8 text-sm text-neutral-500">
        <Link className="underline" href="/">Back to listings</Link>
      </div>
    </main>
  );
}
