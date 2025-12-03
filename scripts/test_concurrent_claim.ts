import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!;

if (!SUPA_URL || !SUPA_KEY) {
  throw new Error('Missing env vars');
}

const supaSvc = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function claimJob(): Promise<any> {
  console.log('[claimJob] Starting query...');
  try {
    const { data: jobs, error } = await supaSvc
      .from('offerup_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);
    
    if (error) {
      console.error('[claimJob] Error:', error);
      throw new Error('select jobs: ' + error.message);
    }
    
    console.log('[claimJob] Success, jobs:', jobs?.length || 0);
    const job = jobs?.[0];
    if (!job) return null;
    
    console.log('[claimJob] Attempting to claim job:', job.id);
    const { data: updated, error: upErr } = await supaSvc
      .from('offerup_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    
    if (upErr) {
      console.error('[claimJob] Update error:', upErr);
      throw new Error('claim job: ' + upErr.message);
    }
    
    if (!updated) {
      console.log('[claimJob] Lost race condition');
      return null;
    }
    
    console.log('[claimJob] Claimed successfully');
    return updated;
  } catch (e: any) {
    console.error('[claimJob] Exception:', e.message);
    console.error('[claimJob] Type:', e.constructor.name);
    if (e.cause) console.error('[claimJob] Cause:', e.cause);
    throw e;
  }
}

async function main() {
  try {
    const CONC = Math.max(1, parseInt(process.env.OU_WORKER_CONCURRENCY || '1', 10) || 1);
    console.log('Concurrency:', CONC);
    console.log('Calling Promise.all with', CONC, 'claimJob calls...');
    const starts = await Promise.all(Array.from({ length: CONC }, () => claimJob()));
    console.log('Promise.all completed:', starts);
  } catch (err: any) {
    console.error('worker failed:', err);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

main();
