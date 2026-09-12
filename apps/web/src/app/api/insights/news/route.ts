import { guarded, requireUser } from "@/lib/session";

/**
 * Australian government supply-watch: live RSS from real government
 * sources, scored for relevance to a takeaway business (supply, prices,
 * recalls, biosecurity), cached 30 minutes. A dead feed is skipped —
 * the dashboard degrades, never breaks.
 */

const FEEDS = [
  { source: "Food Standards (FSANZ)", url: "https://www.foodstandards.gov.au/rss.xml" },
  { source: "Agriculture (DAFF)", url: "https://www.agriculture.gov.au/rss.xml" },
  { source: "Reserve Bank (RBA)", url: "https://www.rba.gov.au/rss/rss-cb-media-releases.xml" },
  { source: "Prime Minister", url: "https://www.pm.gov.au/rss.xml" },
];

// Keywords that matter to a meat-heavy takeaway: each hit lifts relevance.
const KEYWORDS: [RegExp, number, string][] = [
  [/recall/i, 5, "recall"],
  [/\b(meat|beef|lamb|poultry|chicken)\b/i, 5, "meat supply"],
  [/biosecurity|foot.and.mouth|avian|bird flu|lumpy skin/i, 5, "biosecurity"],
  [/\b(shortage|supply chain|supply)\b/i, 4, "supply"],
  [/\b(price|prices|inflation|cost of living|cash rate|interest rate)\b/i, 3, "prices"],
  [/\b(import|export|tariff|trade)\b/i, 3, "trade"],
  [/food (safety|standard)/i, 3, "food safety"],
  [/\b(wage|penalty rates|award|employment)\b/i, 2, "staffing"],
  [/\b(energy|gas|electricity|fuel|freight)\b/i, 2, "energy & freight"],
  [/small business|hospitality|restaurant|takeaway/i, 2, "small business"],
];

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
  relevance: number;
  tags: string[];
}

let cache: { at: number; items: NewsItem[] } | null = null;
const CACHE_MS = 30 * 60_000;

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1]! : "";
}

function parseFeed(source: string, xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks.slice(0, 25)) {
    const title = decode(tag(block, "title"));
    if (!title) continue;
    let link = decode(tag(block, "link"));
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i);
      link = href ? href[1]! : "";
    }
    const dateRaw =
      decode(tag(block, "pubDate")) || decode(tag(block, "updated")) || decode(tag(block, "dc:date"));
    const date = dateRaw ? new Date(dateRaw) : null;
    const summary = decode(tag(block, "description") || tag(block, "summary")).slice(0, 280);
    const text = `${title} ${summary}`;
    let relevance = 1;
    const tags: string[] = [];
    for (const [re, weight, label] of KEYWORDS) {
      if (re.test(text)) {
        relevance += weight;
        tags.push(label);
      }
    }
    items.push({
      source,
      title,
      link,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      summary,
      relevance,
      tags,
    });
  }
  return items;
}

async function fetchAll(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        headers: { "user-agent": "Mozilla/5.0 (MeatboxWA admin dashboard)" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return parseFeed(feed.source, await res.text());
    }),
  );
  const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  // Newest + most relevant first; keep the feed useful, not exhaustive.
  return items
    .sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return b.relevance * 3 + tb / 86_400_000 - (a.relevance * 3 + ta / 86_400_000);
    })
    .slice(0, 30);
}

export const GET = guarded(async () => {
  await requireUser();
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    try {
      cache = { at: Date.now(), items: await fetchAll() };
    } catch {
      cache = cache ?? { at: Date.now(), items: [] };
    }
  }
  return Response.json({ fetchedAt: new Date(cache.at).toISOString(), items: cache.items });
});
