// Cleanup script to delete listings older than 7 days
// Run this daily via cron or manually: tsx scripts/cleanup_old_listings.ts

import { createClient } from '@supabase/supabase-js'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!

if (!SUPA_URL || !SUPA_KEY) {
  console.error('[CLEANUP] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE')
  process.exit(1)
}

const supaSvc = createClient(SUPA_URL, SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function cleanupOldListings() {
  console.log('[CLEANUP] Starting cleanup of old listings...')

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  console.log('[CLEANUP] Deleting listings with first_seen_at <', sevenDaysAgo)

  // First, count how many will be deleted
  const { count: countToDelete } = await supaSvc
    .from('listings')
    .select('*', { count: 'exact', head: true })
    .lt('first_seen_at', sevenDaysAgo)

  console.log('[CLEANUP] Found', countToDelete, 'listings to delete')

  if (!countToDelete || countToDelete === 0) {
    console.log('[CLEANUP] No listings to delete. Exiting.')
    return
  }

  // Delete listings older than 7 days
  const { error, count: deletedCount } = await supaSvc
    .from('listings')
    .delete({ count: 'exact' })
    .lt('first_seen_at', sevenDaysAgo)

  if (error) {
    console.error('[CLEANUP] Error deleting old listings:', error)
    throw error
  }

  console.log('[CLEANUP] ✅ Successfully deleted', deletedCount, 'old listings')
  console.log('[CLEANUP] Cleanup completed at', new Date().toISOString())
}

// Run cleanup
cleanupOldListings()
  .then(() => {
    console.log('[CLEANUP] Script finished successfully')
    process.exit(0)
  })
  .catch((error) => {
    console.error('[CLEANUP] Script failed:', error)
    process.exit(1)
  })
