import { NextRequest, NextResponse } from 'next/server'
import { supaAdmin } from '@/lib/supabase-admin'

export async function POST(request: NextRequest) {
  try {
    const { listingId } = await request.json()

    if (!listingId) {
      return NextResponse.json({ error: 'Missing listingId' }, { status: 400 })
    }

    // Delete from watched_listings table
    const { error } = await supaAdmin
      .from('watched_listings')
      .delete()
      .eq('listing_id', listingId)

    if (error) {
      console.error('Error removing from watched_listings:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in unwatch route:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
