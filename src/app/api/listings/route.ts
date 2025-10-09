// app/api/listings/route.ts
import { NextResponse } from 'next/server';
import { supaAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() || '';
  const minPrice = parseInt(searchParams.get('minPrice') || '') || 0;
  const maxPrice = parseInt(searchParams.get('maxPrice') || '') || 0;
  const titleStatus = searchParams.get('titleStatus'); // clean | salvage | null

  let query = supaAdmin.from('listings').select('*').order('first_seen_at', { ascending: false }).limit(200);

  if (minPrice) query = query.gte('price', minPrice);
  if (maxPrice) query = query.lte('price', maxPrice);
  if (titleStatus && titleStatus !== 'any') query = query.eq('title_status', titleStatus);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const filtered = q
    ? (data || []).filter(r =>
        [r.title, r.make, r.model].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()))
    : data;

  return NextResponse.json(filtered);
}
