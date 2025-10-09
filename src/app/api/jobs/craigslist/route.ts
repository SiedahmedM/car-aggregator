// app/api/jobs/craigslist/route.ts
// src/app/api/jobs/craigslist/route.ts
// src/app/api/jobs/craigslist/route.ts
import { NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';
import { supaAdmin } from '@/lib/supabase-admin';
import { extractRemoteId as extractFromLib, parseListingHtml } from '@/lib/craigslist';
import { fetchViaBee } from '@/lib/proxy';

export const runtime = 'nodejs';

function extractRemoteId(url: string): string | null {
  const m = url.match(/\/(\d{7,})\.html(?:[/?]|$)/);
  return m ? m[1] : extractFromLib(url);
}

function toArray<T = any>(x: any): T[] {
  if (Array.isArray(x)) return x as T[];
  return x ? [x as T] : [];
}

/** Convert an RSS search URL to the equivalent HTML search URL */
function rssToHtmlUrl(rssUrl: string): string {
  // remove format=rss and any trailing '?'/'&'
  const u = new URL(rssUrl);
  u.searchParams.delete('format');
  return u.toString().replace(/[?&]$/, '');
}

/** Extract listing links from a Craigslist search HTML page */
function extractLinksFromSearchHtml(html: string): string[] {
  // look for hrefs ending in /<id>.html
  const links = new Set<string>();
  const re = /href="(https?:\/\/[^"]+\/\d{7,}\.html(?:\?[^"]*)?)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Filter to ensure it's a craigslist domain (avoid ad/other links)
    if (/\.craigslist\.org\//i.test(m[1])) links.add(m[1]);
  }
  return Array.from(links);
}

export async function GET() {
  const envOk =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE);

  const { data: feeds, error: feedsErr } = await supaAdmin
    .from('sources')
    .select('*')
    .eq('source', 'craigslist')
    .eq('enabled', true);

  if (feedsErr) {
    return NextResponse.json(
      { ok: false, step: 'select feeds', error: feedsErr.message, envOk },
      { status: 500 }
    );
  }

  const parser = new XMLParser({ ignoreAttributes: false });
  let inserted = 0;
  let skipped = 0;
  const errors: string[] = [];
  const debug: any = {
    envOk,
    feedsCount: feeds?.length || 0,
    usedBee: Boolean(process.env.SCRAPINGBEE_KEY),
    strategy: 'RSS first; fallback to HTML search when blocked',
    feeds: [] as any[],
  };

  for (const f of feeds || []) {
    const rssUrl: string | undefined = (f.config as any)?.rss;
    const feedDbg: any = {
      rssUrl,
      itemsFromRss: 0,
      itemsFromHtml: 0,
      sampleLinks: [] as string[],
      itemErrors: [] as string[],
    };
    debug.feeds.push(feedDbg);

    if (!rssUrl) {
      feedDbg.itemErrors.push('missing rss url in config');
      continue;
    }

    // 1) Try RSS via Bee
    const rssResp = await fetchViaBee(rssUrl, {
      accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
      isRss: true,
    });

    let candidateLinks: string[] = [];

    if (rssResp.ok && !/Your request has been blocked/i.test(rssResp.text)) {
      // Parse RSS
      try {
        const j = parser.parse(rssResp.text);
        const items = toArray<any>(j?.rss?.channel?.item);
        feedDbg.itemsFromRss = items.length;
        candidateLinks = items
          .map((it: any) =>
            typeof it?.link === 'string'
              ? it.link
              : Array.isArray(it?.link)
              ? it.link[0]
              : null
          )
          .filter(Boolean);
      } catch (e: any) {
        feedDbg.itemErrors.push(`RSS parse failed: ${e?.message}`);
      }
    } else {
      feedDbg.itemErrors.push(`RSS blocked or bad status`);
    }

    // 2) If no RSS items, fallback to HTML search list
    if (candidateLinks.length === 0) {
      const htmlUrl = rssToHtmlUrl(rssUrl);
      const htmlResp = await fetchViaBee(htmlUrl, {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        // keep defaults (no JS, no wait) — page is server-rendered
      });

      if (!htmlResp.ok || /Your request has been blocked/i.test(htmlResp.text)) {
        feedDbg.itemErrors.push(`HTML search blocked or bad status`);
      } else {
        const links = extractLinksFromSearchHtml(htmlResp.text);
        feedDbg.itemsFromHtml = links.length;
        candidateLinks = links;
      }
    }

    feedDbg.sampleLinks = candidateLinks.slice(0, 5);

    // 3) Process candidate links (dedupe by remote_id)
    for (const link of candidateLinks) {
      const remoteId = extractRemoteId(link);
      if (!remoteId) { skipped++; continue; }

      const { data: exists, error: exErr } = await supaAdmin
        .from('listings')
        .select('id')
        .eq('source', 'craigslist')
        .eq('remote_id', remoteId)
        .limit(1)
        .maybeSingle();

      if (exErr) {
        feedDbg.itemErrors.push(`exists check error: ${exErr.message} :: ${link}`);
        continue;
      }
      if (exists) { skipped++; continue; }

      // Fetch detail page via Bee (with small wait to stabilize)
      const detailResp = await fetchViaBee(link, {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        // wait uses BEE_WAIT_MS_DETAIL default
      });

      if (!detailResp.ok || /Your request has been blocked/i.test(detailResp.text)) {
        feedDbg.itemErrors.push(`detail blocked or bad status :: ${link}`);
        continue;
      }

      const parsed = parseListingHtml(detailResp.text);

      const { error: upErr } = await supaAdmin.from('listings').upsert(
        {
          source: 'craigslist',
          remote_id: remoteId,
          url: link,
          title: parsed.title ?? null,
          price: parsed.price,
          city: parsed.city,
          mileage: parsed.mileage,
          title_status: parsed.titleStatus,
          vin: parsed.vin,
          year: parsed.year,
          make: parsed.make,
          model: parsed.model,
          posted_at: null, // no pubDate when from HTML list; it's fine
        },
        { onConflict: 'source,remote_id' }
      );
      if (upErr) {
        feedDbg.itemErrors.push(`upsert error: ${upErr.message} :: ${link}`);
        continue;
      }
      inserted++;
    }
  }

  return NextResponse.json({ ok: true, inserted, skipped, errors, debug });
}