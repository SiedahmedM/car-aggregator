import { NextRequest, NextResponse } from 'next/server'
import { supaAdmin } from '@/lib/supabase-admin'

export async function POST(request: NextRequest) {
  try {
    const { filters, dryRun } = await request.json()

    // Build query from filters (same logic as page.tsx)
    let query = supaAdmin.from('listings').select('id', { count: 'exact' })

    // Apply 48-hour filter by default
    const now = Date.now()
    if (filters.age) {
      const ms =
        filters.age === '30m' ? 30 * 60 * 1000 :
        filters.age === '2h' ? 2 * 60 * 60 * 1000 :
        filters.age === '6h' ? 6 * 60 * 60 * 1000 :
        filters.age === '24h' ? 24 * 60 * 60 * 1000 :
        filters.age === '7d' ? 7 * 24 * 60 * 60 * 1000 : 0
      if (ms) {
        const sinceIso = new Date(now - ms).toISOString()
        query = query.gte('first_seen_at', sinceIso)
      }
    } else {
      // Default: only listings from last 48 hours
      const since48h = new Date(now - 48 * 60 * 60 * 1000).toISOString()
      query = query.gte('first_seen_at', since48h)
    }

    // Ensure first_seen_at is not null
    query = query.not('first_seen_at', 'is', null)

    // Apply other filters
    if (filters.minYear) query = query.gte('year', filters.minYear)
    if (filters.maxYear) query = query.lte('year', filters.maxYear)
    if (filters.minMileage) query = query.gte('mileage', filters.minMileage)
    if (filters.maxMileage) query = query.lte('mileage', filters.maxMileage)
    if (filters.makes?.length) query = query.in('make', filters.makes)
    if (filters.cities?.length) query = query.in('city', filters.cities)
    if (filters.sources?.length) query = query.in('source', filters.sources)

    // Dry run: Just count what would be deleted
    if (dryRun) {
      const { count, error } = await query
      if (error) {
        console.error('Error counting for dry run:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ count, wouldDelete: count })
    }

    // Actual delete: Get IDs then delete in batches
    const { data: items, error: selectError } = await query
    if (selectError) {
      console.error('Error selecting items for delete:', selectError)
      return NextResponse.json({ error: selectError.message }, { status: 500 })
    }

    if (!items?.length) {
      return NextResponse.json({ success: true, deleted: 0 })
    }

    const ids = items.map(item => item.id)

    // Delete in batches of 100
    let totalDeleted = 0
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100)
      const { count, error } = await supaAdmin
        .from('listings')
        .delete({ count: 'exact' })
        .in('id', batch)

      if (error) {
        console.error('Error in batch delete:', error)
        return NextResponse.json({
          error: error.message,
          partialDelete: totalDeleted
        }, { status: 500 })
      }

      totalDeleted += count || 0
    }

    return NextResponse.json({ success: true, deleted: totalDeleted })
  } catch (error) {
    console.error('Error in delete-filtered route:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
