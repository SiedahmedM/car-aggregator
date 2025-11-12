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
  type OfferupParams = {
    minYear?: number;
    maxYear?: number;
    minMileage?: number;
    maxMileage?: number;
    models?: string[];
    minPrice?: number;
    maxPrice?: number;
    postedWithinHours?: number;
    radius?: number;
  };
  type CreateBody = { name?: string; params?: OfferupParams; date_key?: string };
  let body: Partial<CreateBody> = {};
  const ctype = req.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    const parsed = await req.json().catch(() => ({}));
    body = (parsed && typeof parsed === 'object') ? (parsed as Partial<CreateBody>) : {};
  } else {
    const fd = await req.formData();
    const entries = Object.fromEntries(fd.entries()) as Record<string, FormDataEntryValue>;
    body = {};
    // Map discrete fields into params JSON
    const p: OfferupParams = {};
    if (entries.minYear) p.minYear = parseInt(String(entries.minYear), 10) || undefined;
    if (entries.maxYear) p.maxYear = parseInt(String(entries.maxYear), 10) || undefined;
    if (entries.minMileage) p.minMileage = parseInt(String(entries.minMileage), 10) || undefined;
    if (entries.maxMileage) p.maxMileage = parseInt(String(entries.maxMileage), 10) || undefined;
    if (entries.models) p.models = String(entries.models).split(',').map((s: string) => s.trim()).filter(Boolean);
    if (entries.minPrice) p.minPrice = parseInt(String(entries.minPrice), 10) || undefined;
    if (entries.maxPrice) p.maxPrice = parseInt(String(entries.maxPrice), 10) || undefined;
    if (entries.postedWithinHours) p.postedWithinHours = parseInt(String(entries.postedWithinHours), 10) || undefined;
    if (entries.radius) p.radius = parseInt(String(entries.radius), 10) || undefined;
    body.params = p;
    if (entries.name) body.name = String(entries.name);
    if (entries.date_key) body.date_key = String(entries.date_key);
  }
  const name: string = body.name || 'Search';
  const params: OfferupParams = { ...(body.params || {}) };
  // If user didn't explicitly provide models, treat the "name" as model hint
  if ((!params.models || params.models.length === 0) && name && name !== 'Search') {
    params.models = [name.trim()];
  }
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
