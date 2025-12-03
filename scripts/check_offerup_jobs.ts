import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!;

const supaSvc = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

(async () => {
  // Check all jobs
  const { data: allJobs, error } = await supaSvc
    .from('offerup_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  
  if (error) {
    console.error('Error:', error);
    process.exit(1);
  }
  
  console.log('Total jobs found:', allJobs?.length || 0);
  console.log('Jobs:');
  allJobs?.forEach(job => {
    console.log(`  - ${job.id}: ${job.status} (search: ${job.search_id})`);
    console.log(`    Params:`, job.params);
  });
})();
