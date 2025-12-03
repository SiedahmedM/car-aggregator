import { createClient } from '@supabase/supabase-js';

console.log('=== Worker Debug Test ===');
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!;

console.log('URL:', SUPA_URL);
console.log('Key:', SUPA_KEY ? 'SET' : 'MISSING');

if (!SUPA_URL || !SUPA_KEY) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}

const supaSvc = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function claimJob() {
  console.log('Calling claimJob...');
  try {
    const { data: jobs, error } = await supaSvc
      .from('offerup_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      console.error('Supabase error object:', JSON.stringify(error, null, 2));
      throw new Error('select jobs: ' + error.message);
    }
    console.log('Query succeeded, jobs:', jobs);
    return jobs?.[0] || null;
  } catch (e: any) {
    console.error('Exception in claimJob:', e.message);
    console.error('Exception type:', e.constructor.name);
    console.error('Exception cause:', e.cause);
    throw e;
  }
}

async function main() {
  try {
    console.log('Starting main...');
    const CONC = 1;
    console.log('Concurrency:', CONC);
    const starts = await Promise.all(Array.from({ length: CONC }, () => claimJob()));
    console.log('Claims completed:', starts);
  } catch (err: any) {
    console.error('worker failed:', err);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

main();
