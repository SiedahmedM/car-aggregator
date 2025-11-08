// src/app/api/offerup/jobs/cancel/route.ts
import { NextResponse } from 'next/server';
import { supaAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  type CancelBody = { jobIds?: string[]; jobId?: string };
  let body: Partial<CancelBody> = {};
  const ctype = req.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    const parsed = await req.json().catch(() => ({}));
    body = (parsed && typeof parsed === 'object') ? (parsed as Partial<CancelBody>) : {};
  } else {
    const fd = await req.formData();
    const ids = fd.getAll('jobIds[]').map(String).filter(Boolean);
    body.jobIds = ids.length ? ids : undefined;
    const id = fd.get('jobId');
    if (id && !body.jobIds) body.jobIds = [String(id)];
  }
  const ids: string[] = Array.isArray(body.jobIds) ? body.jobIds : (body.jobId ? [String(body.jobId)] : []);
  if (!ids.length) return NextResponse.json({ error: 'Missing jobIds' }, { status: 400 });
  const { error } = await supaAdmin
    .from('offerup_jobs')
    .update({ status: 'cancelled' })
    .in('id', ids)
    .in('status', ['pending','running']);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, cancelled: ids.length });
}

