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
const DEAL_MAX_AGE_HOURS = 72; // older deals are usually expired
const OG_IMAGE_LOOKUPS = 8; // max article-page lookups for items with no image in the feed
const UA = 'Mozilla/5.0 (compatible; PersonalDealsPage/1.0)';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/prefs') return handlePrefs(request, env, url);
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

// ---------- personal picks (likes, hides, watchlist) ----------
// Stored per signed-in person in the KV namespace bound as PREFS, keyed by their Access email.
// The page HTML stays shared and cached; the browser applies the picks (see CLIENT_JS).
const PREFS_HOST = 'deals.whomemc.com'; // only trust the Access email header on the protected custom domain

function sanitizePrefs(o) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const arr = (v, max, n) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x).map((x) => str(x, n)).slice(-max);
  const terms = {};
  if (o && o.terms && typeof o.terms === 'object') {
    for (const k of Object.keys(o.terms).slice(0, 300)) {
      const v = Number(o.terms[k]);
      if (k.length <= 30 && Number.isFinite(v) && v !== 0) terms[k] = Math.max(-5, Math.min(5, Math.round(v)));
    }
  }
  return {
    v: 1,
    watch: arr(o && o.watch, 50, 40).map((w) => w.toLowerCase()),
    terms,
    hidden: arr(o && o.hidden, 400, 300),
    liked: arr(o && o.liked, 300, 300),
  };
}

async function handlePrefs(request, env, url) {
  const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  const reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: H });
  const who = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  if (!env.PREFS) return reply({ enabled: false, why: 'no-kv' });
  if (url.hostname !== PREFS_HOST) return reply({ enabled: false, why: 'host' });
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(who)) return reply({ enabled: false, why: 'no-email' });
  const key = 'p:' + who;
  try {
    if (request.method === 'GET') {
      const prefs = await env.PREFS.get(key, 'json');
      return reply({ enabled: true, prefs: prefs || null });
    }
    if (request.method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return reply({ error: 'bad origin' }, 403);
      const body = await request.text();
      if (body.length > 60000) return reply({ error: 'too large' }, 413);
      let o;
      try { o = JSON.parse(body); } catch (_) { return reply({ error: 'bad json' }, 400); }
      await env.PREFS.put(key, JSON.stringify(sanitizePrefs(o)));
      return reply({ ok: true });
    }
    return reply({ error: 'method not allowed' }, 405);
  } catch (e) {
    console.log('prefs failed', e && e.message);
    return reply({ enabled: false, why: 'error' });
  }
}

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

  // Drop stale and expired deals (but never leave the page nearly empty).
  const cutoff = Date.now() - DEAL_MAX_AGE_HOURS * 3600000;
  const fresh = items.filter((it) => it.date >= cutoff && !/\bexpired\b/i.test(it.title + ' ' + (it.summary || '')));
  if (fresh.length >= 20) items = fresh;
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

// Browser script for the page. String.raw keeps regex backslashes intact (no backticks or dollar-braces inside).
const CLIENT_JS = String.raw`(function(){
  var chips=document.querySelectorAll('.chip'),grid=document.getElementById('grid'),
      cards=[].slice.call(document.querySelectorAll('.card')),
      q=document.getElementById('q'),count=document.getElementById('count'),none=document.getElementById('none'),
      wp=document.getElementById('wp'),wbtn=document.getElementById('wbtn'),wi=document.getElementById('wi'),
      wl=document.getElementById('wl'),hn=document.getElementById('hn'),sh=document.getElementById('sh'),
      rs=document.getElementById('rs'),store=document.getElementById('store');
  var active='all',showHidden=false,H={},L={},serverOn=false,saveT=null,resetArmed=false,toastT=null,lastHidden=null;
  var P={v:1,watch:[],terms:{},hidden:[],liked:[]};
  var STOP={};
  'the and for with from this that your you are was were has have not but all new now off get save one two free deal deals sale just more per out can will any our its after over under only'.split(' ').forEach(function(w){STOP[w]=1});

  function tokens(t){
    var m=String(t||'').toLowerCase().match(/[a-z][a-z0-9+\-]{2,}/g)||[],o=[],seen={};
    m.forEach(function(w){if(!STOP[w]&&!seen[w]){seen[w]=1;o.push(w)}});
    return o;
  }
  function norm(o){
    o=o||{};
    return {v:1,
      watch:Array.isArray(o.watch)?o.watch.slice(0,50):[],
      terms:(o.terms&&typeof o.terms==='object')?o.terms:{},
      hidden:Array.isArray(o.hidden)?o.hidden.slice(-400):[],
      liked:Array.isArray(o.liked)?o.liked.slice(-300):[]};
  }
  function prune(){
    var k=Object.keys(P.terms);
    if(k.length>300){k.sort(function(a,b){return Math.abs(P.terms[b])-Math.abs(P.terms[a])});
      var n={};k.slice(0,250).forEach(function(w){n[w]=P.terms[w]});P.terms=n;}
  }
  function save(){
    prune();
    try{localStorage.setItem('dealsPrefs',JSON.stringify(P))}catch(e){}
    if(!serverOn)return;
    clearTimeout(saveT);
    saveT=setTimeout(function(){
      fetch('/api/prefs',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(P)}).catch(function(){});
    },700);
  }
  function adj(t,d){
    t.forEach(function(w){
      var v=(P.terms[w]||0)+d;v=Math.max(-5,Math.min(5,v));
      if(v===0)delete P.terms[w];else P.terms[w]=v;
    });
  }
  function score(k){
    var s=0,why=[],tx=k.dataset.text;
    P.watch.forEach(function(w){if(w&&tx.indexOf(w)>=0){s+=5;why.push(w)}});
    var t=0;tokens(k.dataset.title).forEach(function(w){t+=(P.terms[w]||0)});
    t=Math.max(-4,Math.min(6,t));s+=t;
    if(t>=2&&!why.length)why.push('like ones you liked');
    return {s:s,why:why};
  }
  function refresh(){
    H={};P.hidden.forEach(function(u){H[u]=1});
    L={};P.liked.forEach(function(u){L[u]=1});
    var any=P.watch.length>0||P.liked.length>0||Object.keys(P.terms).length>0;
    cards.forEach(function(k){
      var r=score(k);k._s=r.s;
      var w=k.querySelector('.why');
      if(r.s>=2&&r.why.length){w.textContent='★ '+r.why.slice(0,2).join(', ');w.hidden=false}else{w.hidden=true}
      k.classList.toggle('liked',!!L[k.dataset.link]);
    });
    document.getElementById('fy').hidden=!any;
    if(!any&&active==='foryou'){active='all';chips.forEach(function(x){x.classList.toggle('on',x.dataset.src==='all')})}
    apply();renderPanel();
  }
  function apply(){
    var terms=q.value.trim().toLowerCase().split(/\s+/).filter(Boolean),shown=0,total=0;
    cards.forEach(function(k){
      var isH=!!H[k.dataset.link],ok=true;
      if(active==='foryou')ok=k._s>=2;
      else if(active==='new')ok=k.classList.contains('new');
      else if(active!=='all')ok=k.dataset.src===active;
      if(isH&&!showHidden)ok=false;
      if(ok&&terms.length){var tx=k.dataset.text;for(var i=0;i<terms.length;i++){if(tx.indexOf(terms[i])<0){ok=false;break}}}
      k.hidden=!ok;k.classList.toggle('dim',isH);
      k.style.order=(active==='foryou')?String(-Math.round(k._s*10)):'0';
      if(!isH||showHidden)total++;
      if(ok)shown++;
    });
    count.textContent=(terms.length||active!=='all')?(shown+' of '+total):(total+' stories');
    none.hidden=shown>0||cards.length===0;
  }
  function renderPanel(){
    wl.textContent='';
    P.watch.forEach(function(w){
      var s=document.createElement('span');s.className='wtag';s.appendChild(document.createTextNode(w));
      var b=document.createElement('button');b.type='button';b.setAttribute('aria-label','Remove '+w);b.textContent='×';
      b.addEventListener('click',function(){P.watch=P.watch.filter(function(x){return x!==w});save();refresh()});
      s.appendChild(b);wl.appendChild(s);
    });
    hn.textContent=P.hidden.length+' hidden';
    sh.textContent=showHidden?'Hide hidden again':'Show hidden';
    rs.textContent=resetArmed?'Tap again to confirm':'Reset what it learned';
    store.textContent=serverOn?'Saved to your account, so it follows you to your phone and other devices.':'Saved in this browser only.';
  }
  function toast(msg,undo){
    var t=document.getElementById('toast');
    if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t)}
    t.textContent='';t.appendChild(document.createTextNode(msg));
    if(undo){var b=document.createElement('button');b.type='button';b.textContent='Undo';b.addEventListener('click',function(){undo();t.hidden=true});t.appendChild(b)}
    t.hidden=false;clearTimeout(toastT);toastT=setTimeout(function(){t.hidden=true},6000);
  }
  function addWatch(){
    var v=wi.value.trim().toLowerCase().replace(/\s+/g,' ').slice(0,40);
    if(!v)return;
    v.split(',').forEach(function(x){x=x.trim();if(x&&P.watch.indexOf(x)<0&&P.watch.length<50)P.watch.push(x)});
    wi.value='';save();refresh();
  }

  grid.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('.act');if(!b)return;
    var k=b.closest('.card'),u=k.dataset.link,t=tokens(k.dataset.title);
    if(b.dataset.a==='up'){
      if(L[u]){P.liked=P.liked.filter(function(x){return x!==u});adj(t,-2)}
      else{
        if(H[u]){P.hidden=P.hidden.filter(function(x){return x!==u});adj(t,2)}
        P.liked.push(u);adj(t,2);
      }
    }else{
      if(H[u]){P.hidden=P.hidden.filter(function(x){return x!==u});adj(t,2)}
      else{
        if(L[u]){P.liked=P.liked.filter(function(x){return x!==u});adj(t,-2)}
        P.hidden.push(u);adj(t,-2);lastHidden=u;
        toast('Hidden. Showing less like it.',function(){
          P.hidden=P.hidden.filter(function(x){return x!==lastHidden});adj(tokens(k.dataset.title),2);save();refresh();
        });
      }
    }
    save();refresh();
  });
  chips.forEach(function(c){c.addEventListener('click',function(){
    chips.forEach(function(x){x.classList.toggle('on',x===c)});
    active=c.dataset.src;apply();
  })});
  wbtn.addEventListener('click',function(){
    wp.hidden=!wp.hidden;wbtn.setAttribute('aria-expanded',String(!wp.hidden));
    if(!wp.hidden)wi.focus();
  });
  document.getElementById('wadd').addEventListener('click',addWatch);
  wi.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();addWatch()}});
  sh.addEventListener('click',function(){showHidden=!showHidden;apply();renderPanel()});
  rs.addEventListener('click',function(){
    if(!resetArmed){resetArmed=true;renderPanel();setTimeout(function(){resetArmed=false;renderPanel()},4000);return}
    resetArmed=false;P.terms={};P.liked=[];P.hidden=[];save();refresh();
  });
  var clr=document.getElementById('clr');
  function sync(){clr.hidden=!q.value}
  q.addEventListener('input',function(){sync();apply()});
  clr.addEventListener('click',function(){q.value='';sync();apply();q.focus()});
  document.addEventListener('keydown',function(e){
    var t=e.target&&e.target.tagName;
    if(e.key==='/'&&t!=='INPUT'&&t!=='TEXTAREA'){e.preventDefault();q.focus();}
    else if(e.key==='Escape'&&document.activeElement===q){q.value='';sync();apply();q.blur();}
  });

  var prev=0;
  try{var ps=sessionStorage.getItem('prevSeen');if(ps===null){ps=localStorage.getItem('lastSeen')||'0';sessionStorage.setItem('prevSeen',ps)}prev=+ps||0;localStorage.setItem('lastSeen',String(Date.now()))}catch(e){}
  var newCount=0;
  cards.forEach(function(k){if(prev>0&&+k.dataset.ts>prev){k.classList.add('new');newCount++}});
  var nw=document.getElementById('nw');if(nw){nw.hidden=!newCount;nw.textContent='New ('+newCount+')'}
  try{var ls=localStorage.getItem('dealsPrefs');if(ls)P=norm(JSON.parse(ls))}catch(e){}
  refresh();
  fetch('/api/prefs',{credentials:'same-origin',cache:'no-store'})
    .then(function(r){return r.ok?r.json():null})
    .then(function(j){
      if(j&&j.enabled){serverOn=true;if(j.prefs){P=norm(j.prefs);try{localStorage.setItem('dealsPrefs',JSON.stringify(P))}catch(e){}}else{save()}refresh()}
    }).catch(function(){});
  var u=document.getElementById('upd');
  if(u){try{u.textContent=new Date(u.getAttribute('datetime')).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}catch(e){}}
})();`;

function render(items, errors, now, debug) {
  const byId = Object.fromEntries(FEEDS.map((f) => [f.id, f]));
  const live = new Set(items.map((it) => it.source));
  const chips = [`<button class="chip on" data-src="all">All</button>`, `<button class="chip" id="nw" data-src="new" style="--c:#2f9e44" hidden>New</button>`, `<button class="chip" id="fy" data-src="foryou" style="--c:#b8860b" hidden>&#9733; For you</button>`]
    .concat(FEEDS.filter((f) => live.has(f.id)).map((f) => `<button class="chip" data-src="${f.id}" style="--c:${f.color}">${esc(f.name)}</button>`))
    .join('');

  const cards = items.map((it) => {
    const f = byId[it.source];
    const img = it.image
      ? `<img src="${esc(it.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('noimg');this.remove()">`
      : '';
    return `<article class="card" data-src="${it.source}" data-ts="${it.date}" data-link="${esc(it.link)}" data-title="${esc(it.title.toLowerCase())}" data-text="${esc((it.title + ' ' + it.summary + ' ' + f.name + ' ' + (it.price || '')).toLowerCase())}" style="--c:${f.color}">
  <a class="thumb${it.image ? '' : ' noimg'}" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer" aria-hidden="true" tabindex="-1">${img}<span class="ph">${esc(f.name.slice(0, 1))}</span></a>
  <div class="body">
    <div class="meta"><span class="src">${esc(f.name)}</span><span class="mr"><time datetime="${new Date(it.date).toISOString()}">${ago(it.date, now)}</time><span class="acts"><button type="button" class="act" data-a="up" title="More like this" aria-label="More like this">&#128077;</button><button type="button" class="act" data-a="down" title="Hide this and show less like it" aria-label="Hide this">&#128078;</button></span></span></div>
    <div class="why" hidden></div>
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
.mr{display:flex;align-items:center;gap:8px}
.acts{display:inline-flex;gap:4px}
.act{appearance:none;border:1px solid var(--line);background:var(--card);border-radius:8px;padding:1px 6px;font-size:.85rem;line-height:1.3;cursor:pointer;filter:grayscale(1);opacity:.55}
.act:hover,.act:focus-visible{opacity:1;filter:none}
.card.liked .act[data-a=up]{opacity:1;filter:none;background:var(--chip)}
.card.dim{opacity:.45}
.why{font-size:.75rem;font-weight:700;color:#b8860b}
.pbtn{appearance:none;border:1px solid var(--line);background:var(--card);color:var(--text);padding:7px 12px;border-radius:10px;font:inherit;font-size:.85rem;cursor:pointer;white-space:nowrap}
.pbtn:hover{border-color:var(--muted)}
#wp{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:0 0 16px;max-width:640px}
#wp[hidden]{display:none}
#wp h3{margin:0 0 4px;font-size:1rem}
#wp .note{margin:0 0 10px;font-size:.8rem;color:var(--muted);display:block}
#wp label{font-size:.85rem;font-weight:600}
.addrow{display:flex;gap:8px;margin:6px 0 10px}
#wi{flex:1;min-width:0;padding:8px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit;font-size:.95rem}
.wl{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.wtag{display:inline-flex;align-items:center;gap:6px;background:var(--chip);border-radius:999px;padding:4px 6px 4px 12px;font-size:.85rem}
.wtag button{appearance:none;border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:1rem;line-height:1;padding:0 4px}
.wfoot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:.8rem;color:var(--muted)}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 14px;border-radius:12px;font-size:.9rem;display:flex;gap:12px;align-items:center;z-index:10}
#toast[hidden]{display:none}
#toast button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}
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
<header><div class="brand"><h1>${esc(PAGE_TITLE)}</h1><nav class="sites" aria-label="My sites"><a href="https://tech.whomemc.com/">Tech</a><a href="https://deals.whomemc.com/" aria-current="page">Deals</a></nav></div><nav class="chips" aria-label="Filter by source">${chips}</nav></header>
<div class="search"><div class="sbox"><input id="q" type="search" placeholder="Search" autocomplete="off" aria-label="Search"><button id="clr" type="button" aria-label="Clear search" hidden>&times;</button></div><span id="count"></span><button class="pbtn" id="wbtn" type="button" aria-expanded="false">My picks</button></div>
<section id="wp" hidden>
  <h3>My picks</h3>
  <p class="note" id="store"></p>
  <label for="wi">Watchlist: words or brands you want to see first</label>
  <div class="addrow"><input id="wi" type="text" maxlength="40" placeholder="e.g. headphones, SSD, 4K TV" autocomplete="off"><button class="pbtn" id="wadd" type="button">Add</button></div>
  <div class="wl" id="wl"></div>
  <div class="wfoot"><span id="hn"></span><button class="pbtn" id="sh" type="button">Show hidden</button><button class="pbtn" id="rs" type="button">Reset what it learned</button></div>
</section>
${empty}
<main class="grid" id="grid">
${cards}
</main>
<p class="nomatch" id="none" hidden>No matching stories.</p>
<footer>Headlines and images belong to their publishers and link to the original articles. Updated <time id="upd" datetime="${new Date(now).toISOString()}"></time>.${errNote}</footer>
</div>
<script>
${CLIENT_JS}
</script>
</body>
</html>`;
}
