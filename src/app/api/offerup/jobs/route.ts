// src/app/api/offerup/jobs/route.ts
import { NextResponse } from 'next/server';
import { supaAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function GET() {
  const { data, error } = await supaAdmin
    .from('offerup_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

