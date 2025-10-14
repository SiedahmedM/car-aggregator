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
  const minYear = parseInt(searchParams.get('minYear') || '') || 0;
  const maxYear = parseInt(searchParams.get('maxYear') || '') || 0;
  const minMileage = parseInt(searchParams.get('minMileage') || '') || 0;
  const maxMileage = parseInt(searchParams.get('maxMileage') || '') || 0;
  const makes = (searchParams.get('makes') || '').split(',').map(s => s.trim()).filter(Boolean);
  const cities = (searchParams.get('cities') || '').split(',').map(s => s.trim()).filter(Boolean);
  const sources = (searchParams.get('sources') || '').split(',').map(s => s.trim()).filter(Boolean); // craigslist, offerup, facebook
  const age = (searchParams.get('age') || '').trim(); // 30m|2h|6h|24h|7d

  let query = supaAdmin.from('listings').select('*').order('first_seen_at', { ascending: false }).limit(200);

  if (minPrice) query = query.gte('price', minPrice);
  if (maxPrice) query = query.lte('price', maxPrice);
  if (titleStatus && titleStatus !== 'any') query = query.eq('title_status', titleStatus);
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
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const filtered = q
    ? (data || []).filter(r =>
        [r.title, r.make, r.model].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()))
    : data;

  return NextResponse.json(filtered);
}
