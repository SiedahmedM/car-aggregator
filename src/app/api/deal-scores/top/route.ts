import { NextResponse } from 'next/server'
import { supaAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10) || 10, 50)

    // Find the last job that was run explicitly (run_now = true), prefer latest
    const { data: lastJob, error: jobErr } = await supaAdmin
      .from('deal_finder_jobs')
      .select('id')
      .eq('run_now', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 500 })
    if (!lastJob) return NextResponse.json([])

    // Load dismissed and saved listing ids to exclude from incoming list
    const [dismissedRes, savedRes] = await Promise.all([
      supaAdmin.from('dismissed_deals').select('listing_id'),
      supaAdmin.from('saved_deals').select('listing_id'),
    ])

    const dismissedIds = (dismissedRes.data || []).map((r: { listing_id: string }) => r.listing_id)
    const savedIds = (savedRes.data || []).map((r: { listing_id: string }) => r.listing_id)

    // Pull top scores for that job
    const { data: scoresData, error: scoresErr } = await supaAdmin
      .from('deal_scores')
      .select('listing_id, score, confidence, created_at')
      .eq('job_id', lastJob.id)
      .order('score', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(100)

    if (scoresErr) return NextResponse.json({ error: scoresErr.message }, { status: 500 })

    // Filter out dismissed/saved and take top N unique listing_ids
    const seen = new Set<string>()
    const filtered: Array<{ listing_id: string; score: number; confidence: number }> = []
    for (const row of scoresData || []) {
      const id = row.listing_id as string
      if (seen.has(id)) continue
      if (dismissedIds.includes(id)) continue
      if (savedIds.includes(id)) continue
      seen.add(id)
      filtered.push({ listing_id: id, score: row.score as number, confidence: row.confidence as number })
      if (filtered.length >= limit) break
    }

    const listingIds = filtered.map((r) => r.listing_id)
    if (!listingIds.length) return NextResponse.json([])

    type ListingRow = { id: string; year: number | null; make: string | null; model: string | null; mileage: number | null; price: number | null; url: string | null }
    const { data: listings, error: listErr } = await supaAdmin
      .from('listings')
      .select('*')
      .in('id', listingIds)

    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 })

    const byId = new Map<string, ListingRow>((listings || []).map((l: ListingRow) => [l.id, l]))
    const result = filtered
      .map((s) => ({ score: s.score, confidence: s.confidence, listing: byId.get(s.listing_id) }))
      .filter((r) => !!r.listing)

    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
