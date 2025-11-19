import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type WinPoint = { year: number; mileage: number; purchasePrice: number }
type JobPayload = {
  make: string
  model: string
  wins?: WinPoint[]          // 3–5 rows (or use referenceCarIds)
  referenceCarIds?: string[]
  sources?: string[]         // ['offerup'] by default
  runNow?: boolean
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY) as string

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as JobPayload
    if (!body?.make || !body?.model) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }
    // Accept either raw wins or reference car ids
    const wins = Array.isArray(body.wins)
      ? body.wins
          .filter((w): w is WinPoint => Number.isFinite(w.year) && Number.isFinite(w.mileage) && Number.isFinite(w.purchasePrice))
          .map((w) => ({ year: +w.year, mileage: +w.mileage, purchasePrice: +w.purchasePrice }))
      : []
    const refIds = Array.isArray(body.referenceCarIds) ? body.referenceCarIds.filter(Boolean) : []

    if (wins.length < 3 && refIds.length < 3) {
      return NextResponse.json({ error: 'Need at least 3 reference points' }, { status: 400 })
    }
    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
    }
    // All same make/model by contract
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

    const { data, error } = await supabase
      .from('deal_finder_jobs')
      .insert({
        make: body.make.toLowerCase(),
        model: body.model.toLowerCase(),
        wins: wins.length ? wins : null,
        reference_car_ids: wins.length ? [] : refIds, // satisfy NOT NULL constraint
        sources: body.sources?.length ? body.sources : ['offerup'],
        status: 'queued',
        run_now: !!body.runNow,
      })
      .select('id')
      .limit(1)
      .single()

    if (error) {
      console.error('[API/jobs] insert error', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const id = (data as { id: string } | null)?.id
    return NextResponse.json({ id }, { status: 201 })
  } catch (e) {
    console.error('[API/jobs] unexpected', e)
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
