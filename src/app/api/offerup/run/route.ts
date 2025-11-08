// src/app/api/offerup/run/route.ts
import { NextResponse } from 'next/server';
import { supaAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

type OfferupSearch = { id: string; params: unknown; created_at?: string; date_key?: string; active?: boolean };

async function getSearchesForTodayOrLast(): Promise<OfferupSearch[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: todays, error } = await supaAdmin
    .from('offerup_searches')
    .select('*')
    .eq('date_key', today)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  if (todays && todays.length) return todays;
  // fallback to last available date
  const { data: lastDateRow, error: dErr } = await supaAdmin
    .from('offerup_searches')
    .select('date_key')
    .order('date_key', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (dErr) throw new Error(dErr.message);
  if (!lastDateRow) return [];
  const lastDate = lastDateRow.date_key;
  const { data: fallback, error: fErr } = await supaAdmin
    .from('offerup_searches')
    .select('*')
    .eq('date_key', lastDate)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (fErr) throw new Error(fErr.message);
  return fallback || [];
}

export async function POST(req: Request) {
  type RunBody = { searchIds?: string[] };
  let body: Partial<RunBody> = {};
  const ctype = req.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    const parsed = await req.json().catch(() => ({}));
    body = (parsed && typeof parsed === 'object') ? (parsed as Partial<RunBody>) : {};
  } else {
    const fd = await req.formData();
    const ids = fd.getAll('searchIds[]').map(String).filter(Boolean);
    body.searchIds = ids.length ? ids : undefined;
  }
  const searchIds: string[] | undefined = body.searchIds;
  let searches: OfferupSearch[] = [];
  if (Array.isArray(searchIds) && searchIds.length) {
    const { data, error } = await supaAdmin
      .from('offerup_searches')
      .select('*')
      .in('id', searchIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    searches = (data || []) as OfferupSearch[];
  } else {
    searches = await getSearchesForTodayOrLast();
  }

  if (!searches.length) return NextResponse.json({ ok: false, message: 'No searches to run' }, { status: 400 });

  const jobs = searches.map(s => ({ search_id: s.id, params: s.params, status: 'pending' as const }));
  const { data: inserted, error } = await supaAdmin
    .from('offerup_jobs')
    .insert(jobs)
    .select('*');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Redirect back to /offerup when invoked from a form
  if (!(req.headers.get('content-type') || '').includes('application/json')) {
    return NextResponse.redirect(new URL('/offerup', req.url), { status: 303 });
  }
  return NextResponse.json({ ok: true, jobs: inserted });
}
