import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string

let client: SupabaseClient | null = null

export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    if (!url || !anon) {
      throw new Error('Missing Supabase env: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY')
    }
    client = createClient(url, anon, { auth: { persistSession: true } })
  }
  return client
}

