import { NextRequest, NextResponse } from 'next/server'
import { supaAdmin } from '@/lib/supabase-admin'

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json()

    // Support both single and bulk operations
    const listingId = body?.listingId
    const listingIds = Array.isArray(body?.listingIds) ? body.listingIds : undefined

    if (!listingId && !listingIds?.length) {
      return NextResponse.json({ error: 'listingId or listingIds required' }, { status: 400 })
    }

    // Determine delete count for validation
    const deleteCount = listingIds?.length || 1

    // Safety check: Prevent accidental mass deletes
    if (deleteCount > 500) {
      return NextResponse.json({
        error: 'Bulk delete limit exceeded. Maximum 500 per request.',
        limit: 500,
        requested: deleteCount
      }, { status: 400 })
    }

    let deletedCount = 0

    if (listingIds?.length) {
      // Bulk delete
      const { error, count } = await supaAdmin
        .from('listings')
        .delete({ count: 'exact' })
        .in('id', listingIds)

      if (error) {
        console.error('Error bulk deleting listings:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      deletedCount = count || 0
    } else {
      // Single delete
      const { error } = await supaAdmin
        .from('listings')
        .delete()
        .eq('id', listingId)

      if (error) {
        console.error('Error deleting listing:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      deletedCount = 1
    }

    return NextResponse.json({
      success: true,
      deleted: deletedCount
    })
  } catch (error) {
    console.error('Error in delete route:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
