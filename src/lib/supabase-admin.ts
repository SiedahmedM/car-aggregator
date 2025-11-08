// lib/supabase-admin.ts
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE // server-side only

if (!url || !key) {
  throw new Error('Missing Supabase environment variables: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE in .env.local')
}

export const supaAdmin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})
