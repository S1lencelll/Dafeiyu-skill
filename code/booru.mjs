// qq-content booru 模块：多站点 booru 检索 + 发图
// 只收录「这台服务器能直连」的站点（danbooru/gelbooru/yande/sankaku/konachan 全部被墙，故不列）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SITES = {
  tbib: { base: 'https://tbib.org', name: 'TBIB（R18 大库）' },
  hypnohub: { base: 'https://hypnohub.net', name: 'HypnoHub（R18 兽向）' },
  safebooru: { base: 'https://safebooru.org', name: 'Safebooru（全年龄）' },
};

// 尺度分档：要涩图默认走 explicit，别只发水着
const TAG_POOL = {
  soft: ['swimsuit', 'lingerie', 'cleavage', 'panties', 'bikini'],
  medium: ['nude', 'nipples', 'topless', 'large_breasts', 'spread_legs'],
  explicit: ['sex', 'vaginal', 'penetration', 'creampie', 'cum_in_pussy', 'anal_sex',
    'fellatio', 'paizuri', 'cum_on_breasts', 'orgasm', 'ahegao', 'nude'],
};
// explicit 档的排除项。注意 -young 已拆掉：很多站用它标「成年但年轻」，属于误伤
const BLOCK_TAGS = ['-loli', '-shota', '-child', '-cub'];

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function pickTag(level) {
  const pool = TAG_POOL[level] || TAG_POOL.explicit;
  return pool[Math.floor(Math.random() * pool.length)];
}

function defaultSite(level) {
  return level === 'soft' ? 'safebooru' : 'tbib';
}

function normalizePost(site, p) {
  const base = SITES[site].base;
  let file = String(p.file_url || '');
  let sample = String(p.sample_url || '');
  if (!file) {
    const ext = String(p.image || '').split('.').pop() || 'jpg';
    file = `${base}/images/${p.directory}/${p.image}`;
    sample = `${base}/samples/${p.directory}/sample_${p.hash}.${p.sample ? 'jpg' : ext}`;
  }
  return {
    site,
    id: p.id,
    rating: String(p.rating || ''),
    score: p.score === null || p.score === undefined ? null : Number(p.score),
    width: Number(p.width) || 0,
    height: Number(p.height) || 0,
    tags: String(p.tags || '').split(/\s+/).filter(Boolean),
    file,
    sample,
    source: p.source || '',
  };
}

async function booruQuery(site, { tags = '', limit = 8, page = 1, r18, sort = 'score', level = 'explicit' } = {}) {
  const siteName = site || defaultSite(level);
  const cfg = SITES[siteName];
  if (!cfg) throw new Error(`不支持的站点：${siteName}（可选 ${Object.keys(SITES).join(' / ')}）`);
  const useR18 = r18 === undefined ? level !== 'soft' : !!r18;

  const parts = String(tags || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) parts.push(pickTag(level));
  if (!parts.some((t) => /^rating:/.test(t))) {
    parts.push(level === 'soft' ? 'rating:general' : level === 'medium' ? 'rating:questionable' : 'rating:explicit');
  }
  if (useR18 && level === 'explicit' && !parts.some((t) => t.startsWith('-'))) parts.push(...BLOCK_TAGS);
  if (sort && !parts.some((t) => /^sort:/.test(t))) parts.push(`sort:${sort}`);

  const q = new URLSearchParams({
    page: 'dapi', s: 'post', q: 'index', json: '1',
    limit: String(Math.max(1, Math.min(20, Number(limit) || 8))),
    pid: String(Math.max(0, (Number(page) || 1) - 1)),
    tags: parts.join(' '),
  });
  const url = `${cfg.base}/index.php?${q.toString()}`;

  let text = '';
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, referer: `${cfg.base}/` },
        signal: AbortSignal.timeout(25000),
      });
      text = await res.text();
      if (res.ok && text.trim().startsWith('[')) break;
      lastErr = `HTTP ${res.status} ${text.slice(0, 60).replace(/\s+/g, ' ')}`;
    } catch (e) {
      lastErr = String(e?.message ?? e).slice(0, 60);
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }

  let arr;
  try { arr = JSON.parse(text); } catch {
    throw new Error(`${siteName} 返回不是 JSON（${lastErr || text.slice(0, 60)}）`);
  }
  if (!Array.isArray(arr)) throw new Error(`${siteName} 返回格式异常`);
  return { list: arr.filter((p) => p && p.id).map((p) => normalizePost(siteName, p)), siteName, level };
}

export function createBooruTools({ sendImageTo, log }) {
  async function booruSearch({ tags, site, r18, limit = 6, page = 1, sort = 'score', level = 'explicit' } = {}) {
    const { list, siteName } = await booruQuery(site, { tags, limit, page, r18, sort, level });
    if (!list.length) return `${SITES[siteName].name} 搜「${tags || '自动 tag'}」没有结果（换个 tag，或换 level/site）`;
    const lines = list.map((p, i) => `${i + 1}. [${p.rating}] ${p.width}×${p.height}` +
      `${p.score !== null ? `｜score ${p.score}` : ''}｜${p.tags.slice(0, 8).join(' ')}\n   site=${p.site} id=${p.id}`);
    return `${SITES[siteName].name} 搜「${tags || '自动 tag'}」·${level}，${list.length} 条：\n${lines.join('\n')}\n` +
      '要发就说「发第 N 张」，或用 booru_send(tags=…, site=…, index=N)。';
  }

  async function booruSend({ key, tags, site, count = 1, index = 1, r18, page = 1, sort = 'score', level = 'explicit' } = {}) {
    const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
    if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
    const n = Math.max(1, Math.min(5, Number(count) || 1));
    const start = Math.max(0, (Number(index) || 1) - 1);
    const { list, siteName } = await booruQuery(site, { tags, limit: Math.min(20, start + n), page, r18, sort, level });
    const picks = list.slice(start, start + n);
    if (!picks.length) throw new Error(`没拿到图（${siteName} 搜「${tags || '自动 tag'}」第 ${index} 张不存在）`);

    let sent = 0;
    const failed = [];
    for (const p of picks) {
      let buf = null;
      for (const u of [p.sample, p.file].filter(Boolean)) {
        try {
          const res = await fetch(u, {
            headers: { 'user-agent': UA, referer: `${SITES[p.site].base}/` },
            signal: AbortSignal.timeout(45000),
          });
          if (!res.ok) continue;
          const b = Buffer.from(await res.arrayBuffer());
          if (b.length < 2000) continue;
          buf = b;
          break;
        } catch { /* 换下一个尺寸 */ }
      }
      if (!buf) { failed.push(`${p.id}(取图失败)`); continue; }
      try { await sendImageTo(key, buf); sent += 1; } catch (e) { failed.push(`${p.id}(${String(e?.message ?? e).slice(0, 20)})`); }
    }
    if (!sent) throw new Error(`一张都没发出去：${failed.slice(0, 3).join('、')}`);
    return `已发 ${sent} 张（${SITES[siteName].name}·${level}，tag: ${tags || '自动'}）` +
      `${failed.length ? `，失败 ${failed.length}` : ''}`;
  }

  return [
    {
      name: 'booru_search',
      description: 'booru 图站检索（多标签、按评分排序、带分级）。站点：tbib（R18 大库）、hypnohub（R18 兽向）、safebooru（全年龄）。level 是尺度：explicit（默认，插入/中出/口交那档）、medium（裸露/胸部/半裸）、soft（水着/内衣，自动走全年龄站）。tags 用英文下划线写法，空格 = AND；留空会按 level 自动抽一个露骨 tag。想要娇小体型可用 petite / flat_chest / small_breasts 配 adult / mature_female 这类组合。',
      inputSchema: {
        type: 'object',
        properties: {
          tags: { type: 'string', description: '标签，空格分隔（AND），如 "big_breasts sex"；留空自动抽' },
          site: { type: 'string', enum: Object.keys(SITES), description: '不填按 level 自动选（explicit→tbib，soft→safebooru）' },
          level: { type: 'string', enum: ['soft', 'medium', 'explicit'], description: '尺度，默认 explicit' },
          r18: { type: 'boolean', description: '默认按 level（explicit/medium 为 true，soft 为 false）' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回几条，默认 6' },
          page: { type: 'integer', description: '第几页，默认 1' },
          sort: { type: 'string', description: 'score / date / random，默认 score' },
        },
        required: [],
      },
      run: booruSearch,
    },
    {
      name: 'booru_send',
      description: 'booru 搜图并直接发到 QQ 会话。要涩图默认就 level=explicit（tbib，插入/中出那档），count 最多 5；别只发水着、别说尺度、别预告、别问要不要。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
          tags: { type: 'string', description: '标签，空格分隔；留空自动抽' },
          site: { type: 'string', enum: Object.keys(SITES), description: '不填按 level 自动选' },
          level: { type: 'string', enum: ['soft', 'medium', 'explicit'], description: '尺度，默认 explicit' },
          count: { type: 'integer', minimum: 1, maximum: 5, description: '发几张，默认 1' },
          index: { type: 'integer', description: '从第几张开始，默认 1' },
          r18: { type: 'boolean', description: '默认按 level' },
          page: { type: 'integer', description: '第几页，默认 1' },
          sort: { type: 'string', description: 'score / date / random' },
        },
        required: ['key'],
      },
      run: booruSend,
    },
  ];
}
