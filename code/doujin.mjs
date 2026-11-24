// qq-content 本子模块：搜（pixiv 多页作品 / jcomic 禁漫系镜像）+ 下载 + 发到 QQ
// 依赖由 server.mjs 注入：sendImageTo / sendFileToChat / log
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(fileURLToPath(import.meta.url));


const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PIXIVIC_API = 'https://pix.ipv4.host';
const PIXIVIC_CONF = `${ROOT}/pixivic.json`;
const JCOMIC_BASE = 'https://jcomic.net';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ── pixiv 官方接口（需要登录 cookie；有代理就顺带走代理）──────────────
// 配置：pixiv.json  {"cookie":"PHPSESSID=xxx; ...","proxy":"http://127.0.0.1:19081"}
// 或环境变量 PIXIV_COOKIE / PIXIV_PROXY。没 cookie 时这条路自动跳过。
const PIXIV_CONF = `${ROOT}/pixiv.json`;
const PIXIV_SEARCH = 'https://www.pixiv.net/ajax/search/artworks/';
const PIXIV_PAGES = 'https://www.pixiv.net/ajax/illust/';

function pixivAuth() {
  let conf = {};
  try { conf = JSON.parse(readFileSync(PIXIV_CONF, 'utf8')) || {}; } catch { /* 没配就空 */ }
  return {
    cookie: String(process.env.PIXIV_COOKIE || conf.cookie || '').trim(),
    proxy: String(process.env.PIXIV_PROXY || conf.proxy || '').trim(),
  };
}

let pixivAgent = null;
let pixivAgentFor = '';

async function pixivFetch(url, auth, timeout = 25000) {
  const headers = {
    'user-agent': UA,
    referer: 'https://www.pixiv.net/',
    accept: 'application/json,image/*,*/*',
    'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8',
  };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (!auth.proxy) return fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  const { ProxyAgent, fetch: proxyFetch } = await import(`${ROOT}/node_modules/undici/index.js`);
  if (pixivAgentFor !== auth.proxy) { pixivAgent = new ProxyAgent(auth.proxy); pixivAgentFor = auth.proxy; }
  return proxyFetch(url, { headers, dispatcher: pixivAgent, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
}

async function pixivOfficialSearch(query, { r18 = true, order = 'popular_male_d', page = 1, blt = '100' } = {}) {
  const auth = pixivAuth();
  if (!auth.cookie) throw new Error('没配置 pixiv cookie');
  const tag = encodeURIComponent(query);
  const url = `${PIXIV_SEARCH}${tag}?word=${tag}&order=${order}&mode=${r18 ? 'r18' : 'safe'}`
    + `&blt=${blt}&p=${Math.max(1, Number(page) || 1)}&s_mode=s_tag&type=all&lang=zh`;
  const res = await pixivFetch(url, auth);
  const j = await res.json().catch(() => null);
  const data = j?.body?.illustManga?.data;
  if (!Array.isArray(data)) throw new Error(`pixiv 搜索失败 HTTP ${res.status}`);
  return data.filter((x) => x?.id).map((x) => ({
    id: String(x.id),
    title: String(x.title ?? ''),
    author: String(x.userName ?? ''),
    tags: (x.tags ?? []).map(String),
    pages: Number(x.pageCount) || 1,
    pageUrls: null,       // 取页时再拉，省请求
    bookmarks: Number(x.bookmarkCount) || 0,
    xr: Number(x.xRestrict) || 0,
    kind: 'pixiv-official',
  }));
}

async function pixivOfficialPages(id) {
  const auth = pixivAuth();
  const res = await pixivFetch(`${PIXIV_PAGES}${String(id)}/pages`, auth);
  const j = await res.json().catch(() => null);
  const list = j?.body;
  if (!Array.isArray(list)) throw new Error(`pixiv 取页失败 HTTP ${res.status}`);
  return list.map((p) => String(p?.urls?.original || p?.urls?.regular || '')).filter(Boolean);
}

// ── pixivic ─────────────────────────────────────────────────────────
function pixivicToken() {
  if (process.env.PIXIVIC_TOKEN) return String(process.env.PIXIVIC_TOKEN);
  try { return JSON.parse(readFileSync(PIXIVIC_CONF, 'utf8')).token || ''; } catch { return ''; }
}

const R18_TAGS = ['R-18', '中出し', 'おっぱい', '裸', '全裸', 'フェラ', 'パイズリ', '断面図', '結合部',
  '絶頂', '潮吹き', '野外露出', '乱交', '寝取られ', '拘束', '調教', 'おもちゃ', '乳首', '局部'];
const SOFT_TAGS = ['魅惑', 'おへそ', 'ナース', '水着', '下着', 'ストッキング', '体操服', 'ビキニ', '尻', '谷間', '透け'];
const NEAR_TAGS = ['構図', '接写', '寄り', '寝そべり', '四つん這い', '上目遣い', 'ローアングル'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function expandTags(query, r18 = true) {
  const q = String(query ?? '').trim();
  if (!q) return r18 ? [pick(R18_TAGS), pick(NEAR_TAGS)] : [pick(SOFT_TAGS)];
  const parts = q.split(/[\s、,,|]+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 4);
  if (/^(本子|本|涩图|色图|本子来点|来点本子|随便|同人志|漫画)$/i.test(q)) {
    return r18 ? [pick(R18_TAGS), pick(R18_TAGS), pick(NEAR_TAGS)] : [pick(SOFT_TAGS), pick(NEAR_TAGS)];
  }
  return r18 && /涩|色|裸|胸|臀|腿|R18|r18/.test(q) ? [q, pick(R18_TAGS)] : [q];
}

async function pixivicFetchJson(path, token) {
  const headers = [
    { 'user-agent': UA, referer: 'https://pixivic.com/', origin: 'https://pixivic.com', authorization: `Bearer ${token}` },
    { 'user-agent': UA, referer: 'https://pixivic.com/', origin: 'https://pixivic.com', authorization: token },
  ];
  let last = '';
  for (const h of headers) {
    const res = await fetch(`${PIXIVIC_API}${path}`, { headers: h, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    if (res.ok) { try { return JSON.parse(text); } catch { throw new Error('pixivic 非 JSON'); } }
    last = `${res.status} ${text.slice(0, 60)}`;
    if (res.status !== 401) break;
  }
  throw new Error(`pixivic 请求失败：${last}`);
}

const toPixivUrl = (real) => (String(real).includes('i.pximg.net')
  ? `https://i.pixiv.re${String(real).split('i.pximg.net')[1]}`
  : String(real));

function normalize(x) {
  const arr = Array.isArray(x?.imageUrls) ? x.imageUrls : [];
  const pages = arr.map((p) => toPixivUrl(p?.original || p?.large || p?.medium || '')).filter(Boolean);
  const artist = x?.artistPreView ?? {};
  return {
    id: String(x?.id ?? ''),
    title: String(x?.title ?? ''),
    author: String(artist.name ?? artist.account ?? ''),
    tags: (Array.isArray(x?.tags) ? x.tags : []).map((t) => (typeof t === 'string' ? t : (t?.translatedName || t?.name || ''))).filter(Boolean),
    pages: Number(x?.pageCount) || pages.length,
    pageUrls: pages,
    bookmarks: Number(x?.totalBookmarks) || 0,
    xr: Number(x?.xrestrict) || 0,
  };
}

async function pixivSearch(query, { r18 = true, pages = 2, pageSize = 50 } = {}) {
  const token = pixivicToken();
  if (!token) throw new Error('pixivic token 缺失（pixivic.json）');
  const tags = expandTags(query, r18);
  const paths = [];
  for (const kw of tags.slice(0, 3)) {
    for (let p = 1; p <= pages; p += 1) {
      paths.push(`/illustrations?keyword=${encodeURIComponent(kw)}&page=${p}&pageSize=${pageSize}`);
    }
  }
  const results = await Promise.all(paths.map((p) => pixivicFetchJson(p, token).catch(() => null)));
  const seen = new Set();
  const out = [];
  for (const j of results) {
    for (const raw of (j?.data ?? [])) {
      if (raw?.type && /ad/i.test(String(raw.type))) continue;
      const w = normalize(raw);
      if (!w.id || !w.pageUrls.length || seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(w);
    }
  }
  out.sort((a, b) => b.bookmarks - a.bookmarks);
  return { list: out, tags };
}

// ── jcomic（禁漫系镜像）─────────────────────────────────────────────
const TRAP = 'JCOMIC_TRAPS_';
function jcomicDecode(v) {
  try { return Buffer.from([...String(v).replace(TRAP, '')].reverse().join(''), 'base64').toString('utf8'); } catch { return ''; }
}

async function jcomicGet(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: `${JCOMIC_BASE}/` }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`jcomic HTTP ${res.status}`);
  return res.text();
}

async function jcomicSearch(query, page = 1) {
  const url = `${JCOMIC_BASE}/search/${encodeURIComponent(query)}${page > 1 ? `/${page}` : ''}`;
  const html = await jcomicGet(url);
  const total = Number((html.match(/找到\s*(\d+)\s*本/) || [])[1] || 0);
  const blocks = html.split('<div class="row col-lg-4').slice(1);
  const items = [];
  for (const b of blocks) {
    const href = (b.match(/href="(\/page\/[^"]+)"/) || [])[1] || '';
    const titleRaw = ((b.match(/comic-title'>([^<]*)</) || [])[1] || '').trim();
    if (!href || !titleRaw) continue;
    const author = ((b.match(/\/author\/([^"]+)"/) || [])[1] || '').trim();
    const lock = (b.match(/data-locked="([^"]+)"/) || [])[1] || '';
    const pages = Number((titleRaw.match(/\((\d+)\)\s*$/) || [])[1] || 0);
    items.push({
      id: `jc:${JCOMIC_BASE}${encodeURI(href)}`,
      url: JCOMIC_BASE + encodeURI(href),
      title: titleRaw.replace(/\s*\(\d+\)\s*$/, ''),
      pages,
      author,
      cover: lock ? jcomicDecode(lock) : '',
      bookmarks: 0,
      tags: [],
    });
  }
  return { total, items };
}

async function jcomicPageUrls(url) {
  const html = await jcomicGet(url);
  return [...html.matchAll(/data-locked="([^"]+)"/g)]
    .map((m) => jcomicDecode(m[1]))
    .filter((u) => /^https?:/.test(u));
}

// ── 下载 / 打包 ────────────────────────────────────────────────────
async function fetchBytes(url, referer, timeout = 45000) {
  // pixiv 原图在 i.pximg.net，被墙；配了代理就走代理
  const auth = pixivAuth();
  const headers = { 'user-agent': UA, referer: referer || `${JCOMIC_BASE}/`, accept: 'image/*' };
  const opts = { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' };
  const res = /pixiv/.test(String(url)) && auth.proxy
    ? await pixivFetch(url, auth, timeout)
    : await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = Buffer.from(await res.arrayBuffer());
  if (b.length < 2000) throw new Error('图太小');
  return b;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 不压缩 zip（STORED），足够给别人解压看图 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);       // UTF-8 名字
    lh.writeUInt16LE(0, 8);            // stored
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, f.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + f.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ── 工具 ───────────────────────────────────────────────────────────
export function createDoujinTools({ sendImageTo, sendFileToChat, log }) {
  /** 内部：找出候选作品（结构化） */
  async function find(query, { r18 = true, source = 'auto', count = 8, minPages = 2, page = 1 } = {}) {
    const want = Math.max(1, Math.min(20, Number(count) || 8));
    const errors = [];
    const auth = pixivAuth();

    // ① pixiv 官方（配了 cookie 才走：能搜 R18、有多页信息）
    if (source === 'auto' || source === 'pixiv-official' || source === 'pixiv') {
      if (auth.cookie) {
        try {
          const list = await pixivOfficialSearch(query, { r18 });
          const hits = list.filter((w) => w.pages >= minPages).slice(0, want);
          if (hits.length) {
            return { source: 'pixiv-official', items: hits, note: `pixiv 官方${auth.proxy ? '·走代理' : ''}${r18 ? '·R18' : ''}` };
          }
          errors.push('pixiv 官方没有多页命中');
        } catch (e) { errors.push(`pixiv 官方：${String(e?.message ?? e).slice(0, 60)}`); }
      } else if (source === 'pixiv-official') {
        throw new Error('没配 pixiv cookie：在 pixiv.json 写 {"cookie":"PHPSESSID=…","proxy":"http://127.0.0.1:19081"}');
      }
    }

    // ② pixivic（不用登录，但只有全年龄）
    if (source !== 'jcomic' && source !== 'pixiv-official') {
      try {
        const { list, tags } = await pixivSearch(query, { r18 });
        const hits = list.filter((w) => w.pages >= minPages).slice(0, want);
        if (hits.length) return { source: 'pixiv', items: hits.map((w) => ({ ...w, kind: 'pixiv' })), note: `tag 组合：${tags.join(' + ')}` };
        errors.push('pixiv 没有多页作品命中');
      } catch (e) { errors.push(`pixiv：${String(e?.message ?? e).slice(0, 60)}`); }
    }

    // ③ jcomic（禁漫系镜像，图片 CDN 可能不通）
    if (source !== 'pixiv' && source !== 'pixiv-official') {
      try {
        const { items, total } = await jcomicSearch(query, page);
        const hits = items.filter((w) => w.pages >= minPages).slice(0, want);
        if (hits.length) return { source: 'jcomic', items: hits.map((w) => ({ ...w, kind: 'jcomic' })), note: `jcomic 共 ${total} 本` };
        errors.push('jcomic 无命中');
      } catch (e) { errors.push(`jcomic：${String(e?.message ?? e).slice(0, 60)}`); }
    }
    return { source: null, items: [], note: errors.join('；') || '没搜到' };
  }

  async function doujinSearch({ query, count = 6, r18 = true, minPages = 2, source = 'auto', page = 1 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('query 不能为空');
    const res = await find(q, { r18, source, count, minPages, page });
    if (!res.items.length) return `搜「${q}」没找到能发的本子（${res.note}）。换个日文关键词再试。`;
    const head = `搜「${q}」${res.source === 'pixiv' ? 'pixiv 多页作品' : 'jcomic 本子'}，${res.items.length} 条（${res.note}）：`;
    const lines = res.items.map((w, i) => `${i + 1}. ${clip(w.title || '(无题)', 42)}｜${w.author || '?'}｜${w.pages} 页` +
      `${w.bookmarks ? `｜收藏 ${w.bookmarks}` : ''}${w.tags?.length ? `｜${w.tags.slice(0, 4).join('、')}` : ''}\n   id: ${w.id}`);
    return `${head}\n${lines.join('\n')}\n要发就说「发第 N 本」，或用 doujin_send(id=…)。`;
  }

  async function doujinSend({ key, id, query, index = 1, mode = 'preview', maxPages = 8, r18 = true, source = 'auto' } = {}) {
    const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
    if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
    const [, kind, target] = m;
    const cap = Math.max(1, Math.min(30, Number(maxPages) || 8));

    let work = null;
    if (id) {
      const raw = String(id).trim();
      if (/^jc:https?:/.test(raw) || /^https?:\/\/jcomic/i.test(raw)) {
        work = { kind: 'jcomic', url: raw.replace(/^jc:/, ''), title: 'jcomic', pages: 0 };
      } else if (/^\d+$/.test(raw)) {
        // 数字 id：先问 pixivic（不用代理），不行再走 pixiv 官方
        let work2 = null;
        try {
          const token = pixivicToken();
          if (token) {
            const j = await pixivicFetchJson(`/illusts/${encodeURIComponent(raw)}`, token).catch(() => null);
            const data = j?.data;
            if (data && Array.isArray(data.imageUrls) && data.imageUrls.length) work2 = { kind: 'pixiv', ...normalize(data) };
          }
        } catch { /* 落到官方 */ }
        if (!work2) {
          const pages = await pixivOfficialPages(raw).catch(() => []);
          if (!pages.length) throw new Error(`取不到 id=${raw} 的页列表（先 doujin_search 再挑，或检查 pixiv cookie / 代理）`);
          work2 = { kind: 'pixiv-official', id: raw, title: `pixiv ${raw}`, pages: pages.length, pageUrls: pages };
        }
        work = work2;
      } else {
        throw new Error('id 要么是 pixiv 数字 id，要么是 doujin_search 返回的 jc: 链接');
      }
    } else if (query) {
      const res = await find(String(query), { r18, source, count: Math.max(1, Number(index) || 1) + 2, minPages: 2 });
      work = res.items[Math.max(0, (Number(index) || 1) - 1)] || null;
      if (!work) throw new Error(`没搜到第 ${index} 本（${res.note}）`);
    } else {
      throw new Error('要么给 id，要么给 query');
    }

    // 取页列表
    let urls = [];
    if (work.kind === 'pixiv') {
      urls = work.pageUrls || [];
    } else if (work.kind === 'pixiv-official') {
      urls = work.pageUrls && work.pageUrls.length ? work.pageUrls : await pixivOfficialPages(work.id);
    } else {
      urls = await jcomicPageUrls(work.url);
    }
    if (!urls.length) throw new Error('拿不到页面地址（源站可能换了反爬）');
    const total = urls.length;
    const use = urls.slice(0, cap);

    const referer = work.kind === 'jcomic' ? `${JCOMIC_BASE}/` : 'https://www.pixiv.net/';
    const bufs = [];
    const failed = [];
    for (const [i, u] of use.entries()) {
      try { bufs.push({ idx: i + 1, data: await fetchBytes(u, referer) }); }
      catch (e) { failed.push(`${i + 1}(${String(e?.message ?? e).slice(0, 20)})`); }
    }
    if (!bufs.length) throw new Error(`一张都没下下来：${failed.slice(0, 3).join('、')}`);

    const title = clip(work.title || '本子', 24);

    if (mode === 'file') {
      // 有签名 URL 会过期，file 模式是当前抓到的这些页；要整本就传 maxPages=30
      const files = bufs.map((b) => ({ name: `${String(b.idx).padStart(3, '0')}.jpg`, data: b.data }));
      const zip = makeZip(files);
      await sendFileToChat({ kind, target, buffer: zip, name: `${title}.zip` });
      return `已发：${title}（${files.length}/${total} 页，zip ${(zip.length / 1048576).toFixed(1)}MB）` +
        `${failed.length ? `，失败 ${failed.length} 页` : ''}`;
    }

    let sent = 0;
    for (const b of bufs) {
      try { await sendImageTo(key, b.data); sent += 1; } catch (e) { failed.push(String(e?.message ?? e).slice(0, 20)); }
    }
    return `已发：${title} 前 ${sent} 页（共 ${total} 页）${failed.length ? `，失败 ${failed.length}` : ''}` +
      `\n想看全部就说「打包发我」（mode=file）。`;
  }

  return [
    {
      name: 'doujin_search',
      description: '搜本子/同人志/多页漫画：按关键词（日文 tag 最准）搜，返回标题、作者、页数、收藏，每条约带 id 供 doujin_send 使用。source=auto 先 pixiv 多页作品、再 jcomic（禁漫系镜像）。r18 默认 true。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，日文命中率最高' },
          count: { type: 'integer', description: '返回几条，默认 6' },
          r18: { type: 'boolean', description: '默认 true' },
          minPages: { type: 'integer', description: '只看几页以上的，默认 2' },
          source: { type: 'string', enum: ['auto', 'pixiv-official', 'pixiv', 'jcomic'], description: '默认 auto' },
          page: { type: 'integer', description: 'jcomic 搜索页码，默认 1' },
        },
        required: ['query'],
      },
      run: doujinSearch,
    },
    {
      name: 'doujin_send',
      description: '把本子发到 QQ 会话：给 id（doujin_search 返回的）或 query+index。mode=preview 按图片发前几页（默认），mode=file 打包 zip 按文件发。key 格式 group:群号 或 private:QQ号。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
          id: { type: 'string', description: 'pixiv 作品 id，或 doujin_search 给的 jc: 链接' },
          query: { type: 'string', description: '没给 id 时用它搜，取第 index 本' },
          index: { type: 'integer', description: '取第几本，默认 1' },
          mode: { type: 'string', enum: ['preview', 'file'], description: 'default=preview' },
          maxPages: { type: 'integer', description: '最多发几页，默认 8，上限 30' },
          r18: { type: 'boolean', description: '默认 true' },
          source: { type: 'string', enum: ['auto', 'pixiv-official', 'pixiv', 'jcomic'] },
        },
        required: ['key'],
      },
      run: doujinSend,
    },
  ];
}
