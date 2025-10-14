// src/app/api/offerup/searches/route.ts
import { NextResponse } from 'next/server';
import { supaAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function GET() {
  const today = new Date();
  const ymd = today.toISOString().slice(0, 10);
  const { data, error } = await supaAdmin
    .from('offerup_searches')
    .select('*')
    .eq('date_key', ymd)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

export async function POST(req: Request) {
  let body: any = {};
  const ctype = req.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    body = await req.json().catch(() => ({}));
  } else {
    const fd = await req.formData();
    body = Object.fromEntries(fd.entries());
    // Map discrete fields into params JSON
    const p: any = {};
    if (body.minYear) p.minYear = parseInt(String(body.minYear), 10) || undefined;
    if (body.maxYear) p.maxYear = parseInt(String(body.maxYear), 10) || undefined;
    if (body.models) p.models = String(body.models).split(',').map((s: string) => s.trim()).filter(Boolean);
    if (body.minPrice) p.minPrice = parseInt(String(body.minPrice), 10) || undefined;
    if (body.maxPrice) p.maxPrice = parseInt(String(body.maxPrice), 10) || undefined;
    if (body.postedWithinHours) p.postedWithinHours = parseInt(String(body.postedWithinHours), 10) || undefined;
    if (body.radius) p.radius = parseInt(String(body.radius), 10) || undefined;
    body.params = p;
  }
  const name: string = body.name || 'Search';
  const params: any = body.params || {};
  const date_key: string = body.date_key || new Date().toISOString().slice(0, 10);
  const { data, error } = await supaAdmin
    .from('offerup_searches')
    .insert({ name, params, date_key, active: true })
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // For HTML form submissions, redirect back to /offerup
  const acceptsJson = (typeof body === 'object') && (typeof body.params !== 'undefined' || (req.headers.get('content-type') || '').includes('application/json'));
  if (!acceptsJson) {
    return NextResponse.redirect(new URL('/offerup', req.url), { status: 303 });
  }
  return NextResponse.json(data);
}
