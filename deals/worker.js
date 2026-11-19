// Deals — a single Cloudflare Worker (same engine as the tech news page).
// Fetches the RSS/Atom feeds below, merges them newest-first, keeps each item's
// image, and serves one fast page. Rendered page is cached at the edge for 10 min.
// Headlines, short summaries and images link back to the original articles.

const FEEDS = [
  { id: 'slickdeals', name: 'Slickdeals', home: 'https://slickdeals.net',     color: '#2b7bd6', urls: ['https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1', 'https://slickdeals.net/newsearch.php?mode=popdeals&searcharea=deals&searchin=first&rss=1', 'https://feeds.feedburner.com/SlickdealsnetUP'] },
  { id: 'dealnews',   name: 'DealNews',   home: 'https://www.dealnews.com',   color: '#d6402f', urls: ['https://www.dealnews.com/?rss=1&sort=time'] },
  { id: 'woot',       name: 'Woot',       home: 'https://www.woot.com',       color: '#3a9d3f', urls: [] },
  { id: 'dealcatcher', name: 'DealCatcher', home: 'https://www.dealcatcher.com', color: '#e8761a', urls: [] },
  { id: 'bradsdeals', name: "Brad's Deals", home: 'https://bradsdeals.com',   color: '#7a4bd1', urls: [] },
];

const PAGE_TITLE = 'Deals';
const ITEMS_PER_FEED = 100;
const MAX_ITEMS = 300;
const CACHE_SECONDS = 300; // deals move fast
const OG_IMAGE_LOOKUPS = 8; // max article-page lookups for items with no image in the feed
const UA = 'Mozilla/5.0 (compatible; PersonalDealsPage/1.0)';

// ---- Sign-in alert emails (Cloudflare Email Routing, send_email binding "EMAIL") ----
// Worker variables (plain text, set in the dashboard):
//   ALERT_TO  = address that receives the alerts (must be verified in Email Routing)
//   ME_EMAILS = comma-separated list of your own sign-in addresses (marks "you" vs "guest")
import { EmailMessage } from 'cloudflare:email';

const ALERT_FROM = 'alerts@whomemc.com';
const ALERT_QUIET_SECONDS = 12 * 3600; // one email per person + device + network per 12 hours

async function loginAlert(request, env, site) {
  try {
    const who = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
    if (!who || !env.EMAIL || !env.ALERT_TO || !/^[^\s@<>]+@[^\s@<>]+$/.test(who)) return;
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = (request.headers.get('User-Agent') || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const keyBytes = new TextEncoder().encode(who + '|' + ip + '|' + ua);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes))].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
    const cache = caches.default;
    const key = new Request('https://alerts.invalid/' + site.replace(/\W/g, '') + '/' + hash);
    if (await cache.match(key)) return;
    await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=' + ALERT_QUIET_SECONDS } }));

    const cf = request.cf || {};
    const place = [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || 'Unknown';
    const device = (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Unknown device')
      + ' · ' + (/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Unknown browser');
    const when = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (Central)';
    const me = String(env.ME_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const mine = me.includes(who);
    const name = who.split('@')[0].replace(/\+.*$/, '');
    const subject = (mine ? 'You' : name) + ' signed in to ' + site;
    const text = [
      site, 'Someone signed in.', '',
      'Who:     ' + who + (mine ? ' (you)' : ' (guest)'),
      'When:    ' + when,
      'Where:   ' + place + ' (approximate, from the network)',
      'Device:  ' + device,
      'Network: ' + ip, '',
      mine ? "If this wasn't you, sign out everywhere in Cloudflare Zero Trust and change your password." :
        "If this isn't someone you invited, remove their email in Cloudflare Zero Trust > Access > Policies.",
    ].join('\r\n');
    const mime = [
      'From: ' + site + ' alerts <' + ALERT_FROM + '>',
      'To: ' + env.ALERT_TO,
      'Subject: ' + subject.replace(/[\r\n]+/g, ' '),
      'Message-ID: <' + crypto.randomUUID() + '@whomemc.com>',
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '', text,
    ].join('\r\n');
    await env.EMAIL.send(new EmailMessage(ALERT_FROM, env.ALERT_TO, mime));
  } catch (e) { console.log('loginAlert failed', e && e.message); }
}
// ---- end sign-in alert ----

export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(loginAlert(request, env, 'Deals'));
    const url = new URL(request.url);
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      return new Response('Not found', { status: 404 });
    }
    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/', { method: 'GET' });
    const refresh = url.searchParams.has('refresh') || url.searchParams.has('debug');
    const debug = url.searchParams.has('debug');

    if (!refresh) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    const { items, errors } = await loadAll();
    const html = render(items, errors, Date.now(), debug);
    const response = new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=300, s-maxage=${CACHE_SECONDS}`,
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      },
    });
    // Only cache if at least something loaded, so a bad moment doesn't stick for 10 minutes.
    if (items.length > 0) if (!debug) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

// ---------- loading ----------

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
    .filter((it) => (seen.has(it.link) ? false : (seen.add(it.link), true)))
    .slice(0, MAX_ITEMS);

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
  // use every address that works (e.g. Slickdeals front page + popular) and merge them
  const got = await Promise.all(feed.urls.map(attempt));
  const merged = [].concat(...got.filter(Boolean));
  if (merged.length) return { items: merged, error: null };

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
      ...extractPrice(title, descHtml || contentHtml),
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

// ---------- price extraction (deals only) ----------
// Looks in the headline first, then the description, for "$39.99", an old price
// ("was $79.99", "reg. $79.99"...) and a percent off. Returns {} if nothing is found.
function extractPrice(title, html) {
  const body = collapse(decodeEntities(stripTags(html || ''))).slice(0, 700);
  const out = {};
  const pickPrice = (text) => {
    const re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 16), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
      // skip "$20 off", "save $20", "$10 gift card", "over $35", "$50 credit", etc.
      if (/^\s*(?:off|discount|back|rebate|gift\s*card|credit|cash\s*back|savings?|shipping)\b/i.test(after)) continue;
      if (/(?:save|extra|coupon|code|credit|off|over|orders?\s+of|spend|purchase|minimum|min\.?|up\s+to|worth)\s*$/i.test(before)) continue;
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0 || n > 100000) continue;
      return { n, label: '$' + m[1] };
    }
    return null;
  };
  const now = pickPrice(title) || pickPrice(body);
  if (now) {
    out.price = now.label;
    const wasRe = /(?:\bwas|\breg(?:ular(?:ly)?)?\.?|\blist(?:\s*price)?|\boriginally|\bmsrp|\bretail(?:s)?(?:\s+for)?|\bnormally|\busually)\s*:?\s*\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/i;
    const wm = (title + ' ' + body).match(wasRe);
    if (wm) {
      const w = parseFloat(wm[1].replace(/,/g, ''));
      if (w > now.n) {
        out.was = '$' + wm[1];
        out.off = Math.round((1 - now.n / w) * 100);
      }
    }
  }
  const pm = (title + ' ' + body).match(/\b(\d{1,2})\s*%\s*off\b/i);
  if (pm) out.off = parseInt(pm[1], 10);
  if (out.off !== undefined && (out.off < 5 || out.off > 95)) delete out.off;
  return out;
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

function render(items, errors, now, debug) {
  const byId = Object.fromEntries(FEEDS.map((f) => [f.id, f]));
  const live = new Set(items.map((it) => it.source));
  const chips = [`<button class="chip on" data-src="all">All</button>`]
    .concat(FEEDS.filter((f) => live.has(f.id)).map((f) => `<button class="chip" data-src="${f.id}" style="--c:${f.color}">${esc(f.name)}</button>`))
    .join('');

  const cards = items.map((it) => {
    const f = byId[it.source];
    const img = it.image
      ? `<img src="${esc(it.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('noimg');this.remove()">`
      : '';
    return `<article class="card" data-src="${it.source}" data-text="${esc((it.title + ' ' + it.summary + ' ' + f.name + ' ' + (it.price || '')).toLowerCase())}" style="--c:${f.color}">
  <a class="thumb${it.image ? '' : ' noimg'}" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer" aria-hidden="true" tabindex="-1">${img}<span class="ph">${esc(f.name.slice(0, 1))}</span></a>
  <div class="body">
    <div class="meta"><span class="src">${esc(f.name)}</span><time datetime="${new Date(it.date).toISOString()}">${ago(it.date, now)}</time></div>
    <h2><a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h2>
    ${(it.price || it.off) ? `<div class="price">${it.price ? `<span class="now">${esc(it.price)}</span>` : ''}${it.was ? `<s>${esc(it.was)}</s>` : ''}${it.off ? `<span class="off">${it.off}% off</span>` : ''}</div>` : ''}
    ${it.summary ? `<p>${esc(it.summary)}</p>` : ''}
  </div>
</article>`;
  }).join('\n');

  const errNote = (debug && errors.length)
    ? `<p class="err">Couldn't load: ${esc(errors.join(' | '))}</p>`
    : '';
  const empty = items.length === 0 ? `<p class="empty">No stories could be loaded right now. Try again in a minute.</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(PAGE_TITLE)}</title>
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
.meta{display:flex;justify-content:space-between;gap:8px;font-size:.78rem;color:var(--muted)}
.src{font-weight:600;color:var(--c)}
h2{font-size:1.02rem;line-height:1.3;margin:0}
h2 a{color:inherit;text-decoration:none}
h2 a:hover{text-decoration:underline}
p{margin:0;color:var(--muted);font-size:.9rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.price{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.now{font-size:1.25rem;font-weight:800}
.price s{color:var(--muted);font-size:.85rem}
.off{background:#dcf5e4;color:#0f5c2c;font-size:.75rem;font-weight:700;padding:2px 8px;border-radius:6px}
@media (prefers-color-scheme:dark){.off{background:#123d23;color:#8ee0ac}}
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
</style>
</head>
<body>
<div class="wrap">
<header><h1>${esc(PAGE_TITLE)}</h1><nav class="chips" aria-label="Filter by source">${chips}</nav></header>
<div class="search"><div class="sbox"><input id="q" type="search" placeholder="Search" autocomplete="off" aria-label="Search"><button id="clr" type="button" aria-label="Clear search" hidden>&times;</button></div><span id="count"></span></div>
${empty}
<main class="grid" id="grid">
${cards}
</main>
<p class="nomatch" id="none" hidden>No matching stories.</p>
<footer>Headlines and images belong to their publishers and link to the original articles. Updated <time id="upd" datetime="${new Date(now).toISOString()}"></time>.${errNote}</footer>
</div>
<script>
(function(){
  var chips=document.querySelectorAll('.chip'),cards=document.querySelectorAll('.card'),
      q=document.getElementById('q'),count=document.getElementById('count'),none=document.getElementById('none'),active='all';
  function apply(){
    var terms=q.value.trim().toLowerCase().split(/\s+/).filter(Boolean),shown=0;
    cards.forEach(function(k){
      var ok=(active==='all'||k.dataset.src===active);
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
