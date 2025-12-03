import { NextRequest, NextResponse } from 'next/server'
import { supaAdmin } from '@/lib/supabase-admin'

export async function POST(request: NextRequest) {
  try {
    const { listingId } = await request.json()

    if (!listingId) {
      return NextResponse.json({ error: 'Missing listingId' }, { status: 400 })
    }

    // Insert into watched_listings table
    const { data: watched, error } = await supaAdmin
      .from('watched_listings')
      .insert({
        listing_id: listingId,
        watched_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) {
      console.error('Error saving to watched_listings:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, watched })
  } catch (error) {
    console.error('Error in watch route:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
