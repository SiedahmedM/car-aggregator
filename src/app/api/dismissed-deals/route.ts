import { NextRequest, NextResponse } from 'next/server'
import { supaAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const listingId: string | undefined = body?.listingId
    const listingIds: string[] | undefined = Array.isArray(body?.listingIds) ? body.listingIds : undefined
    if (!listingId && !(listingIds && listingIds.length)) return NextResponse.json({ error: 'listingId or listingIds required' }, { status: 400 })
    const rows = listingIds?.length ? listingIds.map((id) => ({ listing_id: id })) : [{ listing_id: listingId as string }]
    const { error } = await supaAdmin.from('dismissed_deals').upsert(rows, { onConflict: 'listing_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const listingIds: string[] | undefined = Array.isArray(body?.listingIds) ? body.listingIds : undefined
    if (listingIds && listingIds.length) {
      const { error } = await supaAdmin.from('dismissed_deals').delete().in('listing_id', listingIds)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, cleared: listingIds.length })
    }
    // Clear all if no ids provided
    const { error } = await supaAdmin.from('dismissed_deals').delete().neq('listing_id', '')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
