// scripts/lib/supa.ts
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const svc = process.env.SUPABASE_SERVICE_ROLE!;
if (!url || !svc) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE in env.');
}

export const supaSvc = createClient(url, svc, {
  auth: { persistSession: false, autoRefreshToken: false },
});
