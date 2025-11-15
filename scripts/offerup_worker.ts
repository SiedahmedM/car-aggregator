// scripts/offerup_worker.ts
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

type Job = {
  id: string;
  search_id: string;
  created_at: string;
  status: 'pending'|'running'|'success'|'error'|'cancelled';
  params: any;
};

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!;
if (!SUPA_URL || !SUPA_KEY) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}
const supaSvc = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function claimJob(): Promise<Job | null> {
  // Attempt to atomically claim oldest pending job
  const { data: jobs, error } = await supaSvc
    .from('offerup_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw new Error('select jobs: ' + error.message);
  const job = jobs?.[0];
  if (!job) return null;
  const { data: updated, error: upErr } = await supaSvc
    .from('offerup_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (upErr) throw new Error('claim job: ' + upErr.message);
  if (!updated) return null; // lost race to another worker
  return updated as Job;
}

function runOfferupWithEnv(jobId: string, params: any): Promise<{ ok: boolean; inserted?: number; skipped?: number; errors?: number; raw?: string; cancelled?: boolean }>
{
  return new Promise((resolve) => {
    const env = { ...process.env };
    // Map params to env filters
    if (params.minYear) env.OU_FILTER_MIN_YEAR = String(params.minYear);
    if (params.maxYear) env.OU_FILTER_MAX_YEAR = String(params.maxYear);
    if (params.minMileage) env.OU_FILTER_MIN_MILEAGE = String(params.minMileage);
    if (params.maxMileage) env.OU_FILTER_MAX_MILEAGE = String(params.maxMileage);
    if (params.minPrice) env.OU_FILTER_MIN_PRICE = String(params.minPrice);
    if (params.maxPrice) env.OU_FILTER_MAX_PRICE = String(params.maxPrice);
    if (Array.isArray(params.models) && params.models.length) env.OU_FILTER_MODELS = params.models.join(',');
    if (Array.isArray(params.makes) && params.makes.length) env.OU_FILTER_MAKES = params.makes.join(',');
    if (params.postedWithinHours) env.OU_FILTER_POSTED_WITHIN_HOURS = String(params.postedWithinHours);
    if (params.lat) env.OU_LAT = String(params.lat);
    if (params.lng) env.OU_LNG = String(params.lng);
    if (params.radius) env.OU_RADIUS_MILES = String(params.radius);
    if (params.maxItems) env.OU_MAX_ITEMS = String(params.maxItems);
    if (typeof params.strictModel !== 'undefined') env.OU_STRICT_MODEL = String(params.strictModel);

    const tsxPath = './node_modules/.bin/tsx';
    const child = spawn(tsxPath, ['scripts/offerup.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });

    // Poll for cancellation signal
    let cancelled = false;
    const iv = setInterval(async () => {
      try {
        const { data } = await supaSvc.from('offerup_jobs').select('status').eq('id', jobId).maybeSingle();
        if (data && (data as any).status === 'cancelled') {
          cancelled = true;
          clearInterval(iv);
          try { child.kill('SIGTERM'); } catch {}
        }
      } catch {}
    }, 2000);

    child.on('close', () => {
      clearInterval(iv);
      // Find JSON summary in output
      const m = out.match(/\{\s*"ok"\s*:\s*true[\s\S]*?\}\s*$/m);
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          resolve({ ok: true, inserted: j.inserted, skipped: j.skipped, errors: j.errors, raw: out, cancelled });
          return;
        } catch {}
      }
      resolve({ ok: false, raw: out, cancelled });
    });
  });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function processOne() {
  const job = await claimJob();
  if (!job) return false;
  const result = await runOfferupWithEnv(job.id, job.params || {});
  const patch: any = { finished_at: new Date().toISOString() };
  if (result.cancelled) {
    patch.status = 'cancelled';
  } else if (result.ok) {
    patch.status = 'success';
    patch.result = {
      inserted: result.inserted || 0,
      skipped: result.skipped || 0,
      errors: result.errors || 0,
      log: (result.raw || '').slice(0, 20000),
    };
  } else {
    patch.status = 'error';
    patch.error = (result.raw || '').slice(0, 10000);
    patch.result = {
      inserted: result.inserted || 0,
      skipped: result.skipped || 0,
      errors: result.errors || 0,
      log: (result.raw || '').slice(0, 20000),
    };
  }
  const { error } = await supaSvc.from('offerup_jobs').update(patch).eq('id', job.id);
  if (error) console.error('update job error:', error.message);
  return true;
}

async function main() {
  const CONC = Math.max(1, parseInt(process.env.OU_WORKER_CONCURRENCY || '1', 10) || 1);
  while (true) {
    // Try to start up to CONC jobs in parallel
    const starts = await Promise.all(Array.from({ length: CONC }, () => claimJob()));
    const toRun = starts.filter(Boolean) as Job[];
    if (!toRun.length) { await sleep(5000); continue; }
    await Promise.all(toRun.map(async (j) => {
      const result = await runOfferupWithEnv(j.id, j.params || {});
      const patch: any = { finished_at: new Date().toISOString() };
      if (result.cancelled) {
        patch.status = 'cancelled';
      } else if (result.ok) {
        patch.status = 'success';
        patch.result = {
          inserted: result.inserted || 0,
          skipped: result.skipped || 0,
          errors: result.errors || 0,
          log: (result.raw || '').slice(0, 20000),
        };
      } else {
        patch.status = 'error';
        patch.error = (result.raw || '').slice(0, 10000);
        patch.result = {
          inserted: result.inserted || 0,
          skipped: result.skipped || 0,
          errors: result.errors || 0,
          log: (result.raw || '').slice(0, 20000),
        };
      }
      const { error } = await supaSvc.from('offerup_jobs').update(patch).eq('id', j.id);
      if (error) console.error('update job error:', error.message);
    }));
  }
}

main().catch(err => {
  console.error('worker failed:', err);
  process.exit(1);
});
