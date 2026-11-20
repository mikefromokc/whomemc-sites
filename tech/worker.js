// Apple Tech News — a single Cloudflare Worker.
// Fetches the RSS/Atom feeds below, merges them newest-first, keeps each item's
// image, and serves one fast page. Rendered page is cached at the edge for 10 min.
// Headlines, short summaries and images link back to the original articles.

const FEEDS = [
  { id: '9to5mac',   name: '9to5Mac',   home: 'https://9to5mac.com',          color: '#1d8fe0', urls: ['https://9to5mac.com/feed/'] },
  { id: 'macrumors', name: 'MacRumors', home: 'https://www.macrumors.com',    color: '#d6402f', urls: ['https://feeds.macrumors.com/MacRumors-All', 'https://www.macrumors.com/macrumors.xml'] },
  { id: 'macworld',  name: 'Macworld',  home: 'https://www.macworld.com',     color: '#e8761a', urls: ['https://www.macworld.com/feed'] },
  { id: 'iclarified', name: 'iClarified', home: 'https://www.iclarified.com', color: '#2f9e5b', urls: ['https://www.iclarified.com/rss', 'https://www.iclarified.com/feed'] },
  { id: 'appleinsider', name: 'AppleInsider', home: 'https://appleinsider.com', color: '#7a4bd1', urls: ['https://appleinsider.com/rss/news/'] },
];

const PAGE_TITLE = 'Apple Tech News';
const ITEMS_PER_FEED = 25;
const MAX_ITEMS = 80;        // per fresh load of the feeds
const KEEP_DAYS = 7;         // how far back the page goes (needs the NEWS storage binding)
const HISTORY_MAX = 600;     // safety cap on stored articles
const CACHE_SECONDS = 600;
const OG_IMAGE_LOOKUPS = 8; // max article-page lookups for items with no image in the feed
const UA = 'Mozilla/5.0 (compatible; PersonalTechNewsPage/1.0)';

const ABOUT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>About - About Apple Tech News</title><meta name="description" content="A personal, ad-free reader that gathers Apple news headlines (iPhone, Mac, iPad, Apple Watch) from public RSS feeds of 9to5Mac, MacRumors, Macworld, iClarified and AppleInsider."></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem"><h1>About Apple Tech News</h1><p>A small personal project that collects headlines from the public RSS feeds of Apple-focused news sites (9to5Mac, MacRumors, Macworld, iClarified, AppleInsider) onto one page.</p><p>Every item links to the original publisher. No accounts, no ads, no tracking, and nothing is sold. Hosted on Cloudflare Workers.</p><p><a href="/">Back to the site</a></p></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (url.pathname === '/about') {
      return new Response(ABOUT_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      return new Response('Not found', { status: 404 });
    }
    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/', { method: 'GET' });
    const refresh = url.searchParams.has('refresh');

    if (!refresh) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    const { items, errors } = await loadWithHistory(env);
    const html = render(items, errors, Date.now());
    const response = new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=300, s-maxage=${CACHE_SECONDS}`,
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      },
    });
    // Only cache if at least something loaded, so a bad moment doesn't stick for 10 minutes.
    if (items.length > 0) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },

  // Optional hourly job (Cloudflare cron trigger) so history keeps filling even if nobody opens the page.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(loadWithHistory(env));
  },
};

// ---------- near-duplicate collapse ----------
// The same story or deal often shows up from two sources with slightly different titles.
// Keep the newest, fill in a missing image or price from the other copy.
const DUP_STOP = new Set(['the','and','for','with','from','this','that','your','you','are','free','shipping','off','new','amazon','at','on','in','of','to','a','an','by','up','get','deal','deals','sale']);
function titleTokens(t) {
  const m = String(t || '').toLowerCase().match(/[a-z0-9][a-z0-9.+\-]{1,}/g) || [];
  return new Set(m.filter((w) => !DUP_STOP.has(w)));
}
function nearDup(a, b) {
  if (a.size < 4 || b.size < 4) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter >= 4 && inter / (a.size + b.size - inter) >= 0.6;
}
function collapseNearDuplicates(items) {
  const keep = [], toks = [];
  for (const it of items) {
    const t = titleTokens(it.title);
    const i = toks.findIndex((x) => nearDup(t, x));
    if (i < 0) { keep.push(it); toks.push(t); continue; }
    const k = keep[i];
    if (!k.image && it.image) k.image = it.image;
    if (!k.price && it.price) { k.price = it.price; k.was = it.was; k.off = it.off; }
  }
  return keep;
}

// ---------- loading ----------

// Loads the feeds, then merges with the articles saved earlier so the page can reach back KEEP_DAYS.
// If the NEWS storage (a Workers KV binding) isn't set up, it just returns the fresh feed items.
async function loadWithHistory(env) {
  const { items, errors } = await loadAll();
  if (!env || !env.NEWS) return { items, errors };
  try {
    let old = [];
    try { old = JSON.parse((await env.NEWS.get('items')) || '[]'); } catch (e) { old = []; }
    const byLink = new Map();
    for (const it of old) byLink.set(it.link, it);
    for (const it of items) {
      const prev = byLink.get(it.link);
      byLink.set(it.link, prev && !it.image && prev.image ? { ...it, image: prev.image } : it);
    }
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const mergedAll = [...byLink.values()]
      .filter((it) => it.date >= cutoff)
      .sort((a, b) => b.date - a.date);
    const merged = collapseNearDuplicates(mergedAll).slice(0, HISTORY_MAX);
    if (merged.length) await env.NEWS.put('items', JSON.stringify(merged));
    return { items: merged.length ? merged : items, errors };
  } catch (e) {
    return { items, errors: errors.concat('history: ' + (e && e.message ? e.message : 'storage error')) };
  }
}

async function loadAll() {
  const results = await Promise.all(FEEDS.map(loadFeed));
  const errors = [];
  let items = [];
  results.forEach((r, i) => {
    if (r.error) errors.push(`${FEEDS[i].name}: ${r.error}`);
    items = items.concat(r.items);
  });

  // de-duplicate by link, newest first
  const seen = new Set();
  items = items
    .sort((a, b) => b.date - a.date)
    .filter((it) => (seen.has(it.link) ? false : (seen.add(it.link), true)));
  items = collapseNearDuplicates(items).slice(0, MAX_ITEMS);

  // For a few items that have no image in the feed, look for the article's og:image.
  const missing = items.filter((it) => !it.image).slice(0, OG_IMAGE_LOOKUPS);
  await Promise.allSettled(
    missing.map(async (it) => {
      const res = await timeoutFetch(it.link, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 3600, cacheEverything: true } }, 4000);
      if (!res.ok) return;
      const head = (await res.text()).slice(0, 80000);
      const m =
        head.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
        head.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
      if (m) it.image = absUrl(decodeEntities(m[1]), it.link);
    })
  );
  return { items, errors };
}

async function loadFeed(feed) {
  const tried = [];

  async function attempt(u) {
    try {
      const res = await timeoutFetch(u, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      }, 8000);
      if (!res.ok) { tried.push(`${u} → HTTP ${res.status}`); return null; }
      const text = await res.text();
      if (!looksLikeFeed(text)) { tried.push(`${u} → not a feed`); return null; }
      const items = parseFeed(text, feed).slice(0, ITEMS_PER_FEED);
      if (!items.length) { tried.push(`${u} → no items`); return null; }
      return items;
    } catch (e) {
      tried.push(`${u} → ${e && e.name === 'AbortError' ? 'timeout' : 'failed'}`);
      return null;
    }
  }

  // 1) the configured feed addresses, in order
  for (const u of feed.urls) {
    const items = await attempt(u);
    if (items) return { items, error: null };
  }

  // 2) auto-discover feed links advertised on the home page
  try {
    const res = await timeoutFetch(feed.home, { headers: { 'User-Agent': UA } }, 6000);
    if (!res.ok) {
      tried.push(`${feed.home} → HTTP ${res.status}`);
    } else {
      const html = (await res.text()).slice(0, 100000);
      const tags = html.match(/<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi) || [];
      if (!tags.length) tried.push(`${feed.home} → no feed advertised`);
      for (const t of tags) {
        const href = attr(t, 'href');
        if (!href) continue;
        const items = await attempt(absUrl(href, feed.home));
        if (items) return { items, error: null };
      }
    }
  } catch (e) {
    tried.push(`${feed.home} → ${e && e.name === 'AbortError' ? 'timeout' : 'failed'}`);
  }
  return { items: [], error: tried.join('; ') || 'no feed found' };
}

function timeoutFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ---------- parsing ----------

function looksLikeFeed(text) {
  return /<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 3000));
}

function parseFeed(xml, feed) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const items = [];
  for (const b of blocks) {
    const title = textOf(tagRaw(b, 'title'));
    let link = textOf(tagRaw(b, 'link'));
    if (!link) {
      // Atom: <link rel="alternate" href="..."/>
      const lt = (b.match(/<link\b[^>]*>/gi) || []).find((t) => !/rel=["'](?:self|enclosure|replies)["']/i.test(t));
      if (lt) link = attr(lt, 'href') || '';
    }
    link = absUrl(link, feed.home);
    if (!title || !link) continue;

    const dateStr = textOf(tagRaw(b, 'pubDate')) || textOf(tagRaw(b, 'published')) || textOf(tagRaw(b, 'updated')) || textOf(tagRaw(b, 'dc:date'));
    let date = Date.parse(dateStr);
    if (!Number.isFinite(date)) date = Date.now();

    const contentHtml = htmlOf(tagRaw(b, 'content:encoded')) || htmlOf(tagRaw(b, 'content'));
    const descHtml = htmlOf(tagRaw(b, 'description')) || htmlOf(tagRaw(b, 'summary'));

    const image =
      mediaImage(b, 'media:content') ||
      mediaImage(b, 'media:thumbnail') ||
      enclosureImage(b) ||
      firstImg(contentHtml) ||
      firstImg(descHtml);

    items.push({
      source: feed.id,
      title,
      link,
      date,
      image: image ? absUrl(image, feed.home) : '',
      summary: summarize(descHtml || contentHtml, title),
    });
  }
  return items;
}

function tagRaw(block, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
  return m ? m[1] : '';
}

// Plain text from a tag value (title, link, date).
function textOf(raw) {
  if (!raw) return '';
  return collapse(stripTags(unwrapCdata(raw)));
}

// HTML from a tag value (content/description): CDATA kept as-is, otherwise entity-decoded.
function htmlOf(raw) {
  if (!raw) return '';
  const cd = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cd ? cd[1] : decodeEntities(raw);
}

function unwrapCdata(raw) {
  const cd = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cd ? cd[1] : decodeEntities(raw);
}

function stripTags(s) { return s.replace(/<[^>]*>/g, ' '); }
function collapse(s) { return s.replace(/\s+/g, ' ').trim(); }

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    const v = named[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2]) : '';
}

function isImageUrl(u) { return /\.(?:jpe?g|png|gif|webp|avif)(?:\?|#|$)/i.test(u); }

function mediaImage(block, tagName) {
  const tags = block.match(new RegExp(`<${tagName.replace(':', '\\:')}\\b[^>]*>`, 'gi')) || [];
  let fallback = '';
  for (const t of tags) {
    const u = attr(t, 'url');
    if (!u) continue;
    const medium = attr(t, 'medium').toLowerCase();
    const type = attr(t, 'type').toLowerCase();
    if (medium === 'image' || type.startsWith('image/') || isImageUrl(u)) return u;
    if (!fallback && !medium && !type && tagName === 'media:thumbnail') fallback = u;
  }
  return fallback;
}

function enclosureImage(block) {
  const tags = block.match(/<enclosure\b[^>]*>/gi) || [];
  for (const t of tags) {
    const u = attr(t, 'url');
    const type = attr(t, 'type').toLowerCase();
    if (u && (type.startsWith('image/') || isImageUrl(u))) return u;
  }
  return '';
}

function firstImg(html) {
  if (!html) return '';
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  for (const t of imgs) {
    const src = attr(t, 'data-src') || attr(t, 'data-lazy-src') || attr(t, 'src');
    if (!src || src.startsWith('data:')) continue;
    if (/pixel|tracker|feedburner|gravatar|\/emoji\/|spacer|1x1/i.test(src)) continue;
    const w = parseInt(attr(t, 'width'), 10);
    const h = parseInt(attr(t, 'height'), 10);
    if ((w && w < 50) || (h && h < 50)) continue;
    return src;
  }
  return '';
}

function summarize(html, title) {
  let t = collapse(decodeEntities(stripTags(html || '')));
  t = t.replace(/\s*(?:The post|Read more|Continue reading)\b.*$/i, '').trim();
  if (t.toLowerCase().startsWith(title.toLowerCase())) t = t.slice(title.length).trim();
  if (t.length <= 220) return t;
  const cut = t.slice(0, 220);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 120)).replace(/[\s,.;:–-]+$/, '') + '…';
}

function absUrl(u, base) {
  if (!u) return '';
  try { return new URL(u, base).toString(); } catch (_) { return ''; }
}

// ---------- rendering ----------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function render(items, errors, now) {
  const byId = Object.fromEntries(FEEDS.map((f) => [f.id, f]));
  const chips = [`<button class="chip on" data-src="all">All</button>`, `<button class="chip" id="nw" data-src="new" style="--c:#2f9e44" hidden>New</button>`]
    .concat(FEEDS.map((f) => `<button class="chip" data-src="${f.id}" style="--c:${f.color}">${esc(f.name)}</button>`))
    .join('');

  const cards = items.map((it) => {
    const f = byId[it.source];
    const img = it.image
      ? `<img src="${esc(it.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('noimg');this.remove()">`
      : '';
    return `<article class="card" data-src="${it.source}" data-ts="${it.date}" data-text="${esc((it.title + ' ' + it.summary + ' ' + f.name).toLowerCase())}" style="--c:${f.color}">
  <a class="thumb${it.image ? '' : ' noimg'}" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer" aria-hidden="true" tabindex="-1">${img}<span class="ph">${esc(f.name.slice(0, 1))}</span></a>
  <div class="body">
    <div class="meta"><span class="src">${esc(f.name)}</span><span class="when"><time datetime="${new Date(it.date).toISOString()}">${ago(it.date, now)}</time><button class="share" type="button" data-url="${esc(it.link)}" data-title="${esc(it.title)}" aria-label="Share this article" title="Share"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></button></span></div>
    <h2><a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h2>
    ${it.summary ? `<p>${esc(it.summary)}</p>` : ''}
  </div>
</article>`;
  }).join('\n');

  const errNote = errors.length
    ? `<p class="err">Couldn't load: ${esc(errors.join(' | '))}</p>`
    : '';
  const empty = items.length === 0 ? `<p class="empty">No stories could be loaded right now. Try again in a minute.</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index,follow">
<meta name="description" content="A personal, ad-free reader that gathers Apple news headlines (iPhone, Mac, iPad, Apple Watch) from public RSS feeds of 9to5Mac, MacRumors, Macworld, iClarified and AppleInsider.">
<meta property="og:title" content="Apple Tech News - Apple news headlines from 9to5Mac, MacRumors and more">
<meta property="og:description" content="A personal, ad-free reader that gathers Apple news headlines (iPhone, Mac, iPad, Apple Watch) from public RSS feeds of 9to5Mac, MacRumors, Macworld, iClarified and AppleInsider.">
<meta name="color-scheme" content="light dark">
<title>Apple Tech News - Apple news headlines from 9to5Mac, MacRumors and more</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#14171c;--muted:#656d79;--line:#e3e6eb;--chip:#e9ecf1}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--card:#171a1f;--text:#eceef1;--muted:#98a0ab;--line:#262a31;--chip:#22262d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:space-between;margin-bottom:18px}
h1{font-size:1.5rem;margin:0;letter-spacing:-.01em}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{appearance:none;border:1px solid transparent;background:var(--chip);color:var(--text);padding:7px 14px;border-radius:999px;font:inherit;font-size:.875rem;cursor:pointer}
.chip:hover{border-color:var(--line)}
.chip.on{background:var(--c,var(--text));color:#fff}
.chip[data-src=all].on{background:var(--text);color:var(--bg)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.card[hidden]{display:none}
.thumb{display:block;aspect-ratio:16/9;background:var(--chip);position:relative;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;position:relative;z-index:1}
.thumb .ph{position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:3rem;font-weight:700;color:#fff;background:var(--c)}
.thumb.noimg .ph{display:flex}
.body{padding:12px 14px 16px;display:flex;flex-direction:column;gap:6px}
.meta{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:.78rem;color:var(--muted)}
.when{display:flex;align-items:center;gap:6px}
.share{appearance:none;border:0;background:var(--chip);color:var(--muted);width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font:inherit;font-size:.7rem}
.share:hover{color:var(--text)}
.share.done{width:auto;padding:0 10px;color:#0f5c2c}
.src{font-weight:600;color:var(--c)}
h2{font-size:1.02rem;line-height:1.3;margin:0}
h2 a{color:inherit;text-decoration:none}
h2 a:hover{text-decoration:underline}
p{margin:0;color:var(--muted);font-size:.9rem}
.search{display:flex;align-items:center;gap:12px;margin:0 0 16px}
.sbox{position:relative;flex:1;max-width:520px}
#q{width:100%;box-sizing:border-box;padding:10px 40px 10px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;font-size:1rem}
#q::-webkit-search-cancel-button{-webkit-appearance:none;display:none}
#clr{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:28px;height:28px;border:0;border-radius:50%;background:var(--chip);color:var(--muted);font-size:1.2rem;line-height:1;cursor:pointer;padding:0}
#clr:hover{color:var(--text)}
#clr[hidden]{display:none}
#q:focus{outline:2px solid var(--text);outline-offset:1px}
#count{color:var(--muted);font-size:.85rem;white-space:nowrap}
.nomatch{color:var(--muted);padding:24px 0}
footer{margin-top:24px;color:var(--muted);font-size:.8rem}
.err,.empty{color:#b3261e;font-size:.85rem}
.brand{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px}
.sites{display:flex;gap:6px;font-size:.85rem}
.sites a{color:var(--muted);text-decoration:none;padding:3px 11px;border-radius:999px;border:1px solid var(--line)}
.sites a:hover{color:var(--text);border-color:var(--muted)}
.sites a[aria-current]{background:var(--chip);color:var(--text);border-color:transparent}
.card.new .src::after{content:"NEW";margin-left:8px;font-size:.62rem;font-weight:800;background:#2f9e44;color:#fff;padding:1px 6px;border-radius:5px;letter-spacing:.04em;vertical-align:1px}
</style>
</head>
<body>
<div class="wrap">
<header><div class="brand"><h1>${esc(PAGE_TITLE)}</h1><nav class="sites" aria-label="My sites"><a href="https://tech.whomemc.com/" aria-current="page">Tech</a><a href="https://deals.whomemc.com/">Deals</a></nav></div><nav class="chips" aria-label="Filter by source">${chips}</nav></header>
<div class="search"><div class="sbox"><input id="q" type="search" placeholder="Search" autocomplete="off" aria-label="Search"><button id="clr" type="button" aria-label="Clear search" hidden>&times;</button></div><span id="count"></span></div>
${empty}
<main class="grid" id="grid">
${cards}
</main>
<p class="nomatch" id="none" hidden>No matching stories.</p>
<footer>Headlines and images belong to their publishers and link to the original articles. <a href="/about">About this site</a>. Updated <time id="upd" datetime="${new Date(now).toISOString()}"></time>.${errNote}</footer>
</div>
<script>
(function(){
  var chips=document.querySelectorAll('.chip'),cards=document.querySelectorAll('.card'),
      q=document.getElementById('q'),count=document.getElementById('count'),none=document.getElementById('none'),active='all';
  var prev=0;
  try{var ps=sessionStorage.getItem('prevSeen');if(ps===null){ps=localStorage.getItem('lastSeen')||'0';sessionStorage.setItem('prevSeen',ps)}prev=+ps||0;localStorage.setItem('lastSeen',String(Date.now()))}catch(e){}
  var newCount=0;
  cards.forEach(function(k){if(prev>0&&+k.dataset.ts>prev){k.classList.add('new');newCount++}});
  var nw=document.getElementById('nw');if(nw){nw.hidden=!newCount;nw.textContent='New ('+newCount+')'}
  function apply(){
    var terms=q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean),shown=0;
    cards.forEach(function(k){
      var ok=(active==='all'||(active==='new'?k.classList.contains('new'):k.dataset.src===active));
      if(ok&&terms.length){var tx=k.dataset.text;for(var i=0;i<terms.length;i++){if(tx.indexOf(terms[i])<0){ok=false;break}}}
      k.hidden=!ok;if(ok)shown++;
    });
    count.textContent=(terms.length||active!=='all')?(shown+' of '+cards.length):(cards.length+' stories');
    none.hidden=shown>0||cards.length===0;
  }
  chips.forEach(function(c){c.addEventListener('click',function(){
    chips.forEach(function(x){x.classList.toggle('on',x===c)});
    active=c.dataset.src;apply();
  })});
  var clr=document.getElementById('clr');
  function sync(){clr.hidden=!q.value}
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('.share');if(!b)return;
    var d={title:b.dataset.title,url:b.dataset.url};
    if(navigator.share){navigator.share(d).catch(function(){});return}
    var done=function(){var h=b.innerHTML;b.classList.add('done');b.textContent='Copied';setTimeout(function(){b.classList.remove('done');b.innerHTML=h},1500)};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(d.url).then(done,function(){})}
  });
  q.addEventListener('input',function(){sync();apply()});
  clr.addEventListener('click',function(){q.value='';sync();apply();q.focus()});
  document.addEventListener('keydown',function(e){
    var t=e.target&&e.target.tagName;
    if(e.key==='/'&&t!=='INPUT'&&t!=='TEXTAREA'){e.preventDefault();q.focus();}
    else if(e.key==='Escape'&&document.activeElement===q){q.value='';sync();apply();q.blur();}
  });
  apply();
  var u=document.getElementById('upd');
  if(u){try{u.textContent=new Date(u.getAttribute('datetime')).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}catch(e){}}
})();
</script>
</body>
</html>`;
}
