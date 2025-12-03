import { NextRequest, NextResponse } from 'next/server'
import { supaAdmin } from '@/lib/supabase-admin'

export async function DELETE(request: NextRequest) {
  try {
    const { jobIds } = await request.json()

    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
      return NextResponse.json({ error: 'Missing jobIds' }, { status: 400 })
    }

    const { error } = await supaAdmin
      .from('offerup_jobs')
      .delete()
      .in('id', jobIds)

    if (error) {
      console.error('Error deleting jobs:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, deleted: jobIds.length })
  } catch (error) {
    console.error('Error in delete route:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
