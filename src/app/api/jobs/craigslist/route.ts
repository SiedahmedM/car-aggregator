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

function toArray<T = unknown>(x: unknown): T[] {
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

type FeedDebug = {
  rssUrl?: string;
  itemsFromRss: number;
  itemsFromHtml: number;
  sampleLinks: string[];
  itemErrors: string[];
};

type DebugInfo = {
  envOk: boolean;
  feedsCount: number;
  usedBee: boolean;
  strategy: string;
  feeds: FeedDebug[];
};

type SourceRow = { config?: unknown } & Record<string, unknown>;

function getConfigString(config: unknown, key: string): string | undefined {
  if (config && typeof config === 'object') {
    const v = (config as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
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
  const debug: DebugInfo = {
    envOk,
    feedsCount: feeds?.length || 0,
    usedBee: Boolean(process.env.SCRAPINGBEE_KEY),
    strategy: 'RSS first; fallback to HTML search when blocked',
    feeds: [],
  };

  for (const f of feeds || []) {
    const rssUrl: string | undefined = getConfigString((f as SourceRow).config, 'rss');
    const feedDbg: FeedDebug = {
      rssUrl,
      itemsFromRss: 0,
      itemsFromHtml: 0,
      sampleLinks: [],
      itemErrors: [],
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

    // Map link->pubDate for later use
    const pubByLink = new Map<string, string>();

    if (rssResp.ok && !/Your request has been blocked/i.test(rssResp.text)) {
      // Parse RSS
      try {
        const j = parser.parse(rssResp.text);
        type RssItem = { link?: string | string[]; pubDate?: string };
        const items = toArray<RssItem>(j?.rss?.channel?.item);
        feedDbg.itemsFromRss = items.length;
        const links: string[] = [];
        for (const it of items) {
          const link: string | null =
            typeof it?.link === 'string' ? it.link
            : Array.isArray(it?.link) && typeof it.link[0] === 'string' ? it.link[0]
            : null;
          if (link) {
            links.push(link);
            const pd: string | null = typeof it?.pubDate === 'string' ? it.pubDate : null;
            if (pd) pubByLink.set(link, pd);
          }
        }
        candidateLinks = links;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        feedDbg.itemErrors.push(`RSS parse failed: ${msg}`);
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
      // Prefer RSS pubDate when available; else use parsed postedAt
      let posted_at: string | null = null;
      const pd = pubByLink.get(link);
      if (pd) {
        try { const d = new Date(pd); if (!isNaN(d.getTime())) posted_at = d.toISOString(); } catch {}
      }
      if (!posted_at && parsed.postedAt) posted_at = parsed.postedAt;

      const row: Record<string, unknown> = {
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
      };
      if (posted_at) row.posted_at = posted_at;

      const { error: upErr } = await supaAdmin
        .from('listings')
        .upsert(row, { onConflict: 'source,remote_id' });
      if (upErr) {
        feedDbg.itemErrors.push(`upsert error: ${upErr.message} :: ${link}`);
        continue;
      }
      inserted++;
    }
  }

  return NextResponse.json({ ok: true, inserted, skipped, errors, debug });
}
