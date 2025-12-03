import { createClient } from '@supabase/supabase-js'
import { runDealFinder } from './deal_finder'
import { spawn } from 'child_process' // Add this import at the top

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE!
const supaSvc = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

type WinPoint = { year: number; mileage: number; purchasePrice: number }

async function takeQueuedJob() {
  const { data: job, error } = await supaSvc
    .from('deal_finder_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return job || null
}

async function mark(id: string, patch: Record<string, any>) {
  const { error } = await supaSvc.from('deal_finder_jobs').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

async function processJob(job: any) {
  console.log('[QUEUE] Processing job', job.id, { make: job.make, model: job.model, run_now: job.run_now })
  await mark(job.id, { status: 'running', started_at: new Date().toISOString() })
  try {
    // Auto-clear dismissed results for this make/model when a job starts
    try {
      const { data: ids } = await supaSvc
        .from('listings')
        .select('id')
        .eq('make', job.make)
        .eq('model', job.model)
      const listingIds = (ids || []).map((r: { id: string }) => r.id)
      if (listingIds.length) {
        await supaSvc.from('dismissed_deals').delete().in('listing_id', listingIds)
        console.log('[QUEUE] Cleared dismissed_deals for', job.make, job.model, 'count:', listingIds.length)
      }
    } catch (e) {
      console.warn('[QUEUE] Failed to clear dismissed_deals for', job.make, job.model, e)
    }

    const wins: WinPoint[] | null = Array.isArray(job.wins) ? job.wins : null
    const sources: string[] = Array.isArray(job.sources) && job.sources.length ? job.sources : ['offerup']
    const params: any = wins && wins.length
      ? { wins, make: job.make, model: job.model, sources, jobId: job.id }
      : { referenceCarIds: job.reference_car_ids || [], sources, jobId: job.id }

    const result = await runDealFinder(params)
    await mark(job.id, {
      status: 'success',
      finished_at: new Date().toISOString(),
      result: { totalScored: result.totalScored, topDealsCount: result.topDeals?.length ?? 0 },
    })
    console.log('[QUEUE] Completed job', job.id, 'scored:', result.totalScored)
  } catch (e: any) {
    console.error('[QUEUE] Job failed', job.id, e)
    await mark(job.id, { status: 'error', finished_at: new Date().toISOString(), error: String(e?.message || e) })
  }
}

async function main() {
  console.log('[QUEUE] Deal Finder Queue started')
  while (true) {
    const job = await takeQueuedJob()
    if (!job) {
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    await processJob(job)
  }
}

// Run
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => {
    console.error('[QUEUE] Fatal error', e)
    process.exit(1)
  })
}
