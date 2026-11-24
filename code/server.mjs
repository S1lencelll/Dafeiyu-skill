// qq-content MCP server
// 把 AstrBot 那几个「内容查询」插件的功能搬到 DSH：热榜 / 梗百科 / 番剧。
// 只读、无依赖、stdio JSON-RPC。stdout 只能出协议数据，日志一律走 stderr。

import net from 'node:net';
import { createInterface } from 'node:readline';
import dns from 'node:dns';
import os from 'node:os';
import * as mem from './memory.mjs';
import { createDoujinTools } from './doujin.mjs';
import { createBooruTools } from './booru.mjs';

// 服务器只有 IPv4 出口，但某些域名只回 AAAA（如 image.pollinations.ai）→
// 不显式指定会让 Node fetch 直接失败（curl 会自动回退，Node 不会）。
dns.setDefaultResultOrder('ipv4first');
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录：所有数据/脚本路径都相对它，不写死部署位置 */
const ROOT = dirname(fileURLToPath(import.meta.url));
/** qq-bridge 的 config.json：默认取同级 ../qq-bridge，可用环境变量覆盖 */
const BRIDGE_CONFIG = process.env.QQ_BRIDGE_CONFIG || joinPath(ROOT, '..', 'qq-bridge', 'config.json');
import { ProxyAgent, fetch as proxyFetch } from 'undici';

const execFileAsync = promisify(execFile);

/** Python 解释器：Linux 一般是 python3，Windows 是 python；可用 QQ_CONTENT_PYTHON 覆盖 */
const PY = process.env.QQ_CONTENT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VERSION = '1.0.0';

const log = (...a) => process.stderr.write(`[qq-content] ${a.join(' ')}\n`);

async function getJSON(url, { timeout = 12000, headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { 'user-agent': UA, 'accept': 'application/json,text/plain,*/*', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('响应不是 JSON'); }
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// ── 热榜 ───────────────────────────────────────────────────────────────────
const HOT_SOURCES = {
  baidu: {
    label: '百度热搜',
    url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime',
    pick: (d) => {
      const out = [];
      for (const card of d?.data?.cards ?? []) {
        for (const block of card?.content ?? []) {
          for (const item of block?.content ?? []) {
            const word = item?.word;
            if (word) out.push({ title: word, hot: item?.hotScore ?? null, url: item?.url });
          }
        }
      }
      return out;
    },
  },
  toutiao: {
    label: '头条热榜',
    url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
    pick: (d) => (d?.data ?? []).map((x) => ({
      title: x?.Title, hot: x?.HotValue ?? null,
      url: x?.Url ? String(x.Url).replace(/^\/\//, 'https://') : undefined,
    })).filter((x) => x.title),
  },
  douyin: {
    label: '抖音热点',
    url: 'https://aweme.snssdk.com/aweme/v1/hot/search/list/?device_platform=android',
    pick: (d) => (d?.data?.word_list ?? []).map((x) => ({
      title: x?.word, hot: x?.hot_value ?? null,
    })).filter((x) => x.title),
  },
  bilibili: {
    label: 'B站热搜',
    url: 'https://api.bilibili.com/x/web-interface/search/square?limit=30',
    headers: { referer: 'https://www.bilibili.com/' },
    pick: (d) => (d?.data?.trending?.list ?? []).map((x) => ({
      title: x?.keyword, hot: x?.heat_score ?? null,
      url: x?.keyword ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(x.keyword)}` : undefined,
    })).filter((x) => x.title),
  },
};

async function webHotlist({ source = 'baidu', limit = 10 } = {}) {
  const key = String(source).toLowerCase();
  const src = HOT_SOURCES[key];
  if (!src) throw new Error(`不认识的榜单「${source}」，可选：${Object.keys(HOT_SOURCES).join(' / ')}`);
  const n = Math.max(1, Math.min(30, Number(limit) || 10));
  const data = await getJSON(src.url, { headers: src.headers });
  const items = src.pick(data).slice(0, n);
  if (!items.length) return `${src.label}暂时没取到条目。`;
  const lines = items.map((it, i) => {
    const hot = it.hot ? `（${it.hot}）` : '';
    return `${i + 1}. ${it.title}${hot}`;
  });
  return `${src.label}（${items.length} 条）\n${lines.join('\n')}`;
}

// ── 梗百科 ─────────────────────────────────────────────────────────────────
async function memeLookup({ query, limit = 5 } = {}) {
  const q = clip(query, 60);
  if (!q) throw new Error('query 不能为空');
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const data = await getJSON(`https://cnmeme.wiki/api/v1/public/memes?q=${encodeURIComponent(q)}&limit=${n}`, {
    timeout: 15000,
  });
  const items = data?.items ?? [];
  if (!items.length) return `梗百科里没查到「${q}」。`;
  const lines = items.map((it, i) => {
    const body = clip(it.summary || it.content || '', 220);
    const link = it.slug ? `\n   https://cnmeme.wiki/%E8%AF%8D%E6%9D%A1/${encodeURIComponent(it.slug)}` : '';
    return `${i + 1}. ${it.title || it.slug}：${body}${link}`;
  });
  return `梗百科「${q}」命中 ${items.length} 条\n${lines.join('\n')}`;
}

// ── 番剧 ───────────────────────────────────────────────────────────────────
async function acgLookup({ kind = 'rank', query, limit = 8 } = {}) {
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  const headers = { referer: 'https://www.bilibili.com/' };

  if (String(kind).toLowerCase() === 'search') {
    const q = clip(query, 40);
    if (!q) throw new Error('search 模式需要 query');
    const d = await getJSON(
      `https://api.bilibili.com/x/web-interface/search/type?search_type=media_bangumi&keyword=${encodeURIComponent(q)}`,
      { headers },
    );
    const list = (d?.data?.result ?? []).slice(0, n);
    if (!list.length) return `B站番剧没搜到「${q}」。`;
    return `B站番剧搜索「${q}」\n` + list.map((x, i) =>
      `${i + 1}. ${clip(String(x.title ?? '').replace(/<[^>]+>/g, ''), 60)}｜${clip(x.desc, 80)}\n   https://www.bilibili.com/bangumi/media/md${x.media_id}`,
    ).join('\n');
  }

  const d = await getJSON('https://api.bilibili.com/pgc/web/rank/list?day=3&season_type=1', { headers });
  const list = (d?.result?.list ?? []).slice(0, n);
  if (!list.length) return 'B站番剧榜暂时没取到条目。';
  return 'B站番剧榜（近三日）\n' + list.map((x, i) => {
    const score = x?.rating?.score ? `｜${x.rating.score} 分` : '';
    const stat = x?.stat?.view ? `｜${x.stat.view} 播放` : '';
    const desc = clip(x?.index_show ?? '', 60);
    return `${i + 1}. ${x.title}${score}${stat}${desc ? `\n   ${desc}` : ''}`;
  }).join('\n');
}

// ── 点歌 ───────────────────────────────────────────────────────────────────
// 酷我免登录：search.kuwo.cn/r.s 搜索 + antiserver.kuwo.cn/anti.s 拿直链。
// r.s 返回的是单引号 JS 字面量（不是合法 JSON），所以自己写个配平解析。
function kuwoObjects(text) {
  const start = text.indexOf('abslist');
  if (start < 0) return [];
  let i = text.indexOf('[', start);
  if (i < 0) return [];
  const objs = [];
  let depth = 0, inStr = null, buf = '';
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      buf += ch;
      if (ch === '\\') { buf += text[++i] ?? ''; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; buf += ch; continue; }
    if (ch === '{') { depth += 1; buf += ch; continue; }
    if (ch === '}') {
      depth -= 1;
      buf += ch;
      if (depth === 0) { objs.push(buf); buf = ''; }
      continue;
    }
    if (depth > 0) buf += ch;
    else if (ch === ']') break;
  }
  return objs;
}

function kuwoField(obj, name) {
  const m = new RegExp(`['"]?${name}['"]?\\s*:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(obj);
  if (!m) return '';
  return m[2]
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\\'/g, "'").replace(/\\"/g, '"')
    .trim();
}

// 伴奏/翻唱/演唱会版本排在后面：点歌默认要录音室原版。
const NOISE_RE = /(伴奏|KTV|卡拉|纯音乐|钢琴版|吉他版|翻唱|cover|instrumental|演唱会|现场|live|remix|dj版|改编|片段|串烧|medley|acoustic|八音盒)/i;

async function kuwoSearch(query, limit) {
  const q = clip(query, 50);
  if (!q) throw new Error('query 不能为空');
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const url = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(q)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=${n}&rformat=json&encoding=utf8`;
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'http://www.kuwo.cn/' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`酷我搜索 HTTP ${res.status}`);
  const text = await res.text();
  const list = kuwoObjects(text).map((o) => {
    const rid = (kuwoField(o, 'MUSICRID') || '').replace(/^MUSIC_/i, '');
    return {
      id: rid,
      name: kuwoField(o, 'NAME'),
      artist: kuwoField(o, 'ARTIST').replace(/###/g, ' / ').replace(/&/g, '/'),
      album: kuwoField(o, 'ALBUM'),
      duration: kuwoField(o, 'DURATION'),
    };
  }).filter((x) => x.id && x.name);
  // 稳定排序：命中关键词 > 名字短 > 非伴奏，剩下保持音源原顺序。
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = list.map((x, i) => {
    const hit = tokens.some((t) => x.name.includes(t));
    const exactish = tokens.some((t) => x.name.startsWith(t));
    let score = (hit ? 0 : 10) + (NOISE_RE.test(x.name) ? 5 : 0) + Math.min(x.name.length, 99) / 1000;
    if (exactish) score -= 1;
    return { x, i, score };
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.map((s) => s.x).slice(0, n);
}

async function kuwoUrl(rid) {
  const res = await fetch(
    `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_${encodeURIComponent(rid)}&format=mp3&response=url`,
    { headers: { 'user-agent': UA, referer: 'http://www.kuwo.cn/' }, signal: AbortSignal.timeout(20000) },
  );
  const text = (await res.text()).trim();
  if (!/^https?:\/\//.test(text)) throw new Error('没拿到可播放直链（可能版权受限）');
  return text;
}

function onebotConfig() {
  try {
    const c = JSON.parse(readFileSync(BRIDGE_CONFIG, 'utf8'));
    return { url: String(c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/$/, ''), token: String(c.snowluma?.accessToken ?? '') };
  } catch {
    return { url: 'http://127.0.0.1:3000', token: '' };
  }
}

async function onebotCall(action, payload) {
  const { url, token } = onebotConfig();
  const res = await fetch(`${url}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (body?.status !== 'ok') throw new Error(`${action} 失败：${body?.message ?? body?.wording ?? res.status}`);
  return body.data;
}

// 搜索用网易云：相关性准、返回合法 JSON。播放用酷我：免登录能拿直链。
// （网易云 outer/url 已经拿不到音频了，返回的是版权页。）
async function neteaseSearch(query, limit) {
  const q = clip(query, 50);
  if (!q) throw new Error('query 不能为空');
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const d = await getJSON(
    `http://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=${n}&offset=0`,
    { headers: { referer: 'https://music.163.com/' } },
  );
  return (d?.result?.songs ?? []).map((s) => ({
    id: String(s.id),
    name: String(s?.name ?? ''),
    artist: (s?.artists ?? []).map((a) => a?.name).filter(Boolean).join(' / '),
    album: String(s?.album?.name ?? ''),
    durationMs: Number(s?.duration ?? 0),
  })).filter((s) => s.id && s.name);
}

async function neteaseDetail(id) {
  const d = await getJSON(`http://music.163.com/api/song/detail/?ids=[${encodeURIComponent(id)}]`, {
    headers: { referer: 'https://music.163.com/' },
  });
  const s = (d?.songs ?? [])[0];
  if (!s) throw new Error(`网易云查不到 id=${id}`);
  return {
    id: String(s.id),
    name: String(s?.name ?? ''),
    artist: (s?.artists ?? []).map((a) => a?.name).filter(Boolean).join(' / '),
  };
}

// 酷狗搜索：免签名，曲库对华语/独占歌手比网易云全（周杰伦等），但播放要登录，
// 所以这里只拿它当「这首歌到底叫什么、谁唱的」的权威来源。
async function kugouSearch(query, limit) {
  const q = clip(query, 50);
  if (!q) throw new Error('query 不能为空');
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const d = await getJSON(
    `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(q)}&page=1&pagesize=${n}`,
    { headers: { referer: 'http://m.kugou.com/' } },
  );
  return ((d?.data?.info) ?? []).map((x) => ({
    id: String(x?.hash ?? ''),
    name: String(x?.songname ?? ''),
    artist: String(x?.singername ?? ''),
    album: String(x?.album_name ?? ''),
    durationMs: Number(x?.duration ?? 0) * 1000,
    source: 'kugou',
  })).filter((s) => s.id && s.name);
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\-_()（）[\]【】·'"’“”!！?？.,，/]/g, '');

// 用「歌名+歌手」在酷我的候选里挑最像的那一首。返回 {c, score} 或 null。
function kuwoPick(candidates, name, artist) {
  const target = norm(name);
  const targetArtist = norm(artist);
  let best = null;
  for (const c of candidates) {
    const nm = norm(c.name);
    let score;
    if (nm === target) score = 0;
    else if (nm.includes(target) || target.includes(nm)) score = 1;
    else score = 3;
    if (NOISE_RE.test(c.name)) score += 5;
    if (targetArtist && norm(c.artist).includes(targetArtist.slice(0, 4))) score -= 0.5;
    score += Math.min(c.name.length, 99) / 1000;
    if (!best || score < best.score) best = { c, score };
  }
  return best;
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

// 三源合并搜歌：网易云（广）+ 酷狗（准，覆盖华语独占歌手）。
// 酷我只用来找「能播的版本」，不参与结果排序——它的多词查询是或逻辑。
function rankSongs(list, query) {
  const toks = String(query ?? '').split(/\s+/).map(norm).filter(Boolean);
  return list.map((s, i) => {
    const nm = norm(s.name);
    const ar = norm(s.artist);
    const nameHits = toks.filter((t) => nm.includes(t)).length;
    const artistHits = toks.filter((t) => ar.includes(t)).length;
    // 歌手完全相等（搜「孤勇者 陈奕迅」时 artist 恰好是「陈奕迅」）要明显压过
    // 「陈奕迅、新乐府民乐气氛组」这种合作/改编版。
    const artistExact = toks.some((t) => ar === t);
    // 中文歌名却配了个纯拉丁歌手名（Lie / Jay / RyaVocal），多半是翻唱上传，
    // 不带歌手搜「稻香」时靠这条把原唱顶上去。
    const cjkName = /[\u4e00-\u9fa5]/.test(s.name);
    const cjkArtist = /[\u4e00-\u9fa5]/.test(String(s.artist));
    let score = (nameHits ? 0 : 2) + (artistHits ? 0 : 1.5)
      + (NOISE_RE.test(s.name) ? 3 : 0)
      + (cjkName && !cjkArtist ? 0.4 : 0)
      + Math.min(s.name.length, 60) / 1000
      + Math.min(String(s.artist).length, 40) / 2000
      - nameHits * 0.5 - artistHits * 0.5
      - (artistExact ? 0.8 : 0)
      // 极小的源偏好：酷狗华语原唱覆盖率更高，用来打破「翻唱 vs 原唱」的同分僵局。
      // 只给 0.05，压不过任何实质性的歌名/歌手命中差异。
      + (s.source === 'kugou' ? -0.05 : 0);
    return { s, i, score };
  }).sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.s);
}

// GD 音乐台（music.gdstudio.xyz）的聚合 API：它的 netease 源能给 320k 直链，
// 这是直接调网易云 open api 拿不到的（那边 url 恒为 null）。第三方代持，不碰用户账号。
const GD_API = 'https://music-api.gdstudio.xyz/api.php';

async function gdSearch(query, limit, source = 'netease') {
  const q = clip(query, 50);
  if (!q) throw new Error('query 不能为空');
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const d = await getJSON(
    `${GD_API}?types=search&source=${source}&name=${encodeURIComponent(q)}&count=${n}&pages=1`,
    { headers: { referer: 'https://music.gdstudio.xyz/' }, timeout: 15000 },
  );
  if (!Array.isArray(d)) throw new Error(`GD 搜索返回异常：${JSON.stringify(d).slice(0, 80)}`);
  return d.map((x) => ({
    id: String(x?.id ?? ''),
    name: String(x?.name ?? ''),
    artist: Array.isArray(x?.artist) ? x.artist.join(' / ') : String(x?.artist ?? ''),
    album: String(x?.album ?? ''),
    source: source === 'netease' ? 'gd-netease' : `gd-${source}`,
  })).filter((s) => s.id && s.name);
}

async function gdUrl(id, br = 320, source = 'netease') {
  const d = await getJSON(
    `${GD_API}?types=url&source=${source}&id=${encodeURIComponent(id)}&br=${br}`,
    { headers: { referer: 'https://music.gdstudio.xyz/' }, timeout: 20000 },
  );
  const url = typeof d?.url === 'string' ? d.url : '';
  if (!/^https?:\/\//.test(url)) return null;
  return { url, br: d?.br ?? br, size: d?.size ?? 0 };
}

async function combinedSearch(query, limit) {
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const settled = await Promise.allSettled([
    gdSearch(query, n + 3, 'netease'),
    kugouSearch(query, n + 3),
    neteaseSearch(query, n + 3),
  ]);
  const out = [];
  const seen = new Set();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const s of r.value) {
      const key = `${norm(s.name)}|${norm(s.artist).slice(0, 6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return rankSongs(out, query).slice(0, n);
}

// 版权独占曲（周杰伦等）酷我也拿不到原版时，退到 B站 取音频流。
// 注意：B站 CDN 校验 Referer，所以必须服务端下载后用 base64 发。
async function bilibiliAudio(name, artist) {
  const q = `${name} ${artist ?? ''}`.trim();
  const d = await getJSON(
    `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(q)}&page=1`,
    { headers: { referer: 'https://www.bilibili.com/' } },
  );
  const results = d?.data?.result ?? [];
  if (!results.length) return null;
  const target = norm(name);
  const pick = results.find((r) => norm(stripTags(r.title)).includes(target)) ?? results[0];
  const bvid = pick?.bvid;
  if (!bvid) return null;

  const pg = await biliGet(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
  const cid = (pg?.data ?? [])[0]?.cid;
  if (!cid) return null;

  const pu = await biliGet(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1`);
  const audios = pu?.data?.dash?.audio ?? [];
  if (!audios.length) return null;
  const best = audios.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];

  const res = await fetch(best.baseUrl, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50000) return null;
  return { buf, title: stripTags(pick.title), bvid };
}

async function musicSearch({ query, limit = 5 } = {}) {
  const raw = await combinedSearch(query, limit + 4);
  // 歌手过滤：查询里带了歌手名，结果 artist 必须对得上
  const filtered = pickCandidates(raw, query);
  const list = filtered.slice(0, limit);
  if (!list.length) return `没搜到「${query}」。`;
  const dropped = raw.length - filtered.length;
  const note = dropped > 0 ? `（滤掉 ${dropped} 首歌手不符的）` : '';
  return `搜到 ${list.length} 首${note}：\n` + list.map((s, i) => {
    const mm = s.durationMs ? `${Math.floor(s.durationMs / 1000 / 60)}:${String(Math.floor((s.durationMs / 1000) % 60)).padStart(2, '0')}` : '';
    const coverish = /(版|翻唱|cover|原唱|伴奏|纯音乐|钢琴)/i.test(s.name) ? ' ⚠︎可能是翻唱/版本' : '';
    const src = s.source === 'kugou' ? '酷狗' : s.source === 'gd-netease' ? '网易云(GD)' : '网易云';
    return `${i + 1}. ${s.name} - ${s.artist}${mm ? `（${mm}）` : ''}  [${src}][id:${s.id}]${coverish}`;
  }).join('\n') + '\n\n要放的话调 music_play，带上 key 和 index。';
}

async function musicPlay({ query, id, index = 1, key } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  const send = (payload) => onebotCall(kind === 'group' ? 'send_group_msg' : 'send_private_msg',
    kind === 'group' ? { group_id: Number(target), ...payload } : { user_id: Number(target), ...payload });

  // 1) 先确定「要哪首歌」
  let song;
  const wanted = String(id ?? '').trim();
  if (wanted && /^\d+$/.test(wanted)) {
    song = await neteaseDetail(wanted);
  } else if (wanted) {
    // 酷狗 hash：它的搜索里回查一次拿到歌名
    const found = (await kugouSearch(query || wanted, 10)).find((x) => x.id === wanted);
    song = found ?? (await combinedSearch(query || '', 10))[0];
  } else {
    const list = await combinedSearch(query, 10);
    if (!list.length) return `没搜到「${query}」。`;
    song = list[Math.max(1, Math.min(list.length, Number(index) || 1)) - 1];
  }
  if (!song) return `没找到「${query ?? id}」这首歌。`;

  // 2) 第一优先：GD 聚合的网易云源，能直接给 320k 直链（不占用户账号）
  try {
    let gdId = song.source === 'gd-netease' ? song.id : '';
    if (!gdId) {
      const hits = await gdSearch(`${song.name} ${song.artist}`, 5, 'netease');
      const best = hits.find((h) => norm(h.name) === norm(song.name))
        ?? hits.find((h) => norm(h.name).includes(norm(song.name)));
      gdId = best?.id ?? '';
    }
    if (gdId) {
      const got = await gdUrl(gdId, 320);
      if (got) {
        const data = await send({ message: [{ type: 'record', data: { file: got.url } }] });
        return `已发送《${song.name} - ${song.artist}》到 ${key}（音源：网易云 ${got.br}k，message_id: ${data?.message_id ?? '?'}）`;
      }
    }
  } catch (error) {
    log('gd url failed:', error?.message ?? error);
  }

  // 3) 酷我：体积小、免登录
  for (const q of [`${song.name} ${song.artist}`, song.name]) {
    let candidates = [];
    try { candidates = await kuwoSearch(q, 10); } catch { candidates = []; }
    const best = kuwoPick(candidates, song.name, song.artist);
    if (best && best.score < 2) {
      const audio = await kuwoUrl(best.c.id);
      const data = await send({ message: [{ type: 'record', data: { file: audio } }] });
      return `已发送《${song.name} - ${song.artist}》到 ${key}（音源：酷我 ${best.c.name}，message_id: ${data?.message_id ?? '?'}）`;
    }
  }

  // 4) 酷我没有原版（版权独占）→ 退到 B站
  try {
    const bb = await bilibiliAudio(song.name, song.artist);
    if (bb) {
      const data = await send({ message: [{ type: 'record', data: { file: `base64://${bb.buf.toString('base64')}` } }] });
      return `已发送《${song.name} - ${song.artist}》到 ${key}（音源：B站 ${bb.bvid}「${clip(bb.title, 30)}」，message_id: ${data?.message_id ?? '?'}）`;
    }
  } catch (error) {
    log('bilibili audio failed:', error?.message ?? error);
  }

  return `《${song.name} - ${song.artist}》两个音源都没拿到可播版本（酷我无版权、B站也没取到音频）。换个版本或换首歌试试。`;
}

// ── 搜图 / 发图 ────────────────────────────────────────────────────────────
// 四个源：360 图库、Bing 图片、搜狗图片（HTML 里抠 picUrl）、Safebooru（二次元）。
const IMG_EXT_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i;
const upgrade = (u) => String(u ?? '').trim().replace(/^http:\/\//i, 'https://');

// 分页：不传就用随机页，避免搜「猫」永远返回同一批图。
const pickPage = (page, maxPages = 4) => {
  const p = Number(page);
  if (Number.isFinite(p) && p > 0) return Math.min(20, Math.floor(p));
  return Math.floor(Math.random() * maxPages);
};

// 中文关键词 → safebooru 英文 tag。只收常见词，翻不出来的原样传（safebooru 只认英文）。
const TAG_ZH = {
  '猫': 'cat', '猫咪': 'cat', '小猫': 'cat', '狗': 'dog', '狗狗': 'dog', '兔': 'rabbit',
  '女孩': 'girl', '男孩': 'boy', '少女': 'girl', '男生': 'boy', '双马尾': 'twintails',
  '长发': 'long_hair', '短发': 'short_hair', '金发': 'blonde_hair', '银发': 'silver_hair',
  '蓝发': 'blue_hair', '黑发': 'black_hair', '白发': 'white_hair', '粉发': 'pink_hair',
  '眼睛': 'eyes', '蓝眼': 'blue_eyes', '红眼': 'red_eyes', '绿眼': 'green_eyes',
  '和服': 'kimono', '浴衣': 'yukata', '校服': 'school_uniform', '水手服': 'serafuku',
  '女仆': 'maid', '泳装': 'swimsuit', '比基尼': 'bikini', '连衣裙': 'dress',
  '猫耳': 'cat_ears', '兽耳': 'animal_ears', '尾巴': 'tail', '翅膀': 'wings',
  '樱花': 'sakura', '花': 'flower', '天空': 'sky', '云': 'clouds', '海': 'ocean',
  '风景': 'scenery', '夜景': 'night', '夕阳': 'sunset', '雨': 'rain', '雪': 'snow',
  '森林': 'forest', '城市': 'city', '星空': 'starry_sky', '月亮': 'moon',
  '魔法': 'magic', '剑': 'sword', '枪': 'gun', '机甲': 'mecha',
  '站立': 'standing', '坐着': 'sitting', '睡觉': 'sleeping', '微笑': 'smile',
  '笑': 'smile', '哭': 'crying', '脸红': 'blush', '单人': 'solo', '两人': '2girls',
};

// 空格 = AND；前缀 - 表示排除；中文自动换成英文 tag。
function normalizeTags(query) {
  const parts = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  const mapped = parts.map((tok) => {
    const sign = /^[-+]/.test(tok) ? tok[0] : '';
    const body = sign ? tok.slice(1) : tok;
    const en = TAG_ZH[body] ?? TAG_ZH[body.toLowerCase()] ?? body;
    return sign + en;
  });
  // safebooru 的 tag 分隔符：AND 用空格（URL 里是 + 或 %20），排除用 -
  return mapped.join(' ');
}

const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

async function src360(query, n, page) {
  // 实测 360 的 pn 不生效（page=1/3 返回一模一样），但一次能给 100+ 条：
  // 所以固定取一大把，再随机切片，比翻页更有效。
  const d = await getJSON(`https://image.so.com/j?q=${encodeURIComponent(query)}&pn=0&rn=60&src=srp`, {
    headers: { referer: 'https://image.so.com/' },
  });
  const list = (d?.list ?? []).map((x) => ({
    url: upgrade(x?.img || x?.thumb),
    title: String(x?.title ?? '').trim(),
    source: '360',
  }));
  return shuffle(list).slice(0, n + 5);
}

// ja-JP 加权：日区更容易出二次元图。
const BING_MKTS = ['ja-JP', 'zh-CN', 'ja-JP', 'en-US'];

async function srcBing(query, n, page) {
  const mkt = BING_MKTS[Math.floor(Math.random() * BING_MKTS.length)];
  const host = mkt === 'zh-CN' ? 'cn.bing.com' : 'www.bing.com';
  // Bing 的 first 实测也不生效（0/35 返回同一批），所以靠 mkt 轮换 + 随机切片换图。
  const res = await fetch(
    `https://${host}/images/async?q=${encodeURIComponent(query)}&first=0&count=${Math.min(35, n + 5)}&mkt=${mkt}`,
    { headers: { 'user-agent': UA, referer: `https://${host}/` }, signal: AbortSignal.timeout(15000) },
  );
  const html = await res.text();
  const out = [];
  const re = /murl&quot;:&quot;(.*?)&quot;/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ url: upgrade(m[1].replace(/&amp;/g, '&')), title: '', source: 'bing' });
  }
  return shuffle(out).slice(0, n + 5);
}

async function srcSogou(query, n, page) {
  const start = pickPage(page, 3) * 48;
  const res = await fetch(`https://pic.sogou.com/pics?query=${encodeURIComponent(query)}&start=${start}`, {
    headers: { 'user-agent': UA, referer: 'https://pic.sogou.com/' },
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const out = [];
  const re = /"picUrl":"(.*?)"/g;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1];
    try { u = JSON.parse(`"${u}"`); } catch { u = u.replace(/\\\//g, '/'); }
    out.push({ url: upgrade(u), title: '', source: 'sogou' });
  }
  // start 能翻页，但同一页里也要随机取，否则连搜几次首图都一样。
  return shuffle(out).slice(0, n + 5);
}

async function srcSafebooru(query, n, page) {
  // 原生支持多 tag AND（空格）与排除（-tag），中文走 TAG_ZH 翻译。
  const tags = normalizeTags(query);
  const pid = pickPage(page, 4);
  const d = await getJSON(
    `https://safebooru.org/index.php?page=dapi&s=post&q=index&tags=${encodeURIComponent(tags)}&pid=${pid}&limit=${Math.min(20, n + 5)}&json=1`,
  );
  const arr = Array.isArray(d) ? d : [];
  return arr.map((x) => ({
    url: upgrade(x?.sample_url || x?.file_url || x?.preview_url),
    title: '',
    source: 'safebooru',
  }));
}

const IMG_SOURCES = { '360': src360, bing: srcBing, sogou: srcSogou, safebooru: srcSafebooru };

// 近 30 分钟发过的图不再优先返回：同一个词连搜两次也能换一批。
const RECENT_TTL = 30 * 60 * 1000;
const recentlyServed = new Map();
const isRecent = (key) => {
  const t = recentlyServed.get(key);
  if (!t) return false;
  if (Date.now() - t > RECENT_TTL) { recentlyServed.delete(key); return false; }
  return true;
};
const markServed = (key) => {
  recentlyServed.set(key, Date.now());
  if (recentlyServed.size > 1000) {
    const cut = Date.now() - RECENT_TTL;
    for (const [k, v] of recentlyServed) if (v < cut) recentlyServed.delete(k);
  }
};

async function collectImages(query, count, source, page) {
  const n = Math.max(1, Math.min(10, Number(count) || 6));
  const wanted = String(source ?? 'all').toLowerCase();
  const picked = wanted === 'all'
    ? Object.entries(IMG_SOURCES)
    : Object.entries(IMG_SOURCES).filter(([k]) => k === wanted);
  if (!picked.length) throw new Error(`不认识的图源「${source}」，可选：all / ${Object.keys(IMG_SOURCES).join(' / ')}`);

  const settled = await Promise.allSettled(picked.map(([, fn]) => fn(query, n, page)));
  const out = [];
  const seen = new Set();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!item.url || !IMG_EXT_RE.test(item.url)) continue;
      const key = item.url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  // 近 30 分钟发过的排到后面：同一关键词连搜两次也能换一批。
  const fresh = out.filter((it) => !isRecent(it.url.split('?')[0]));
  const stale = out.filter((it) => isRecent(it.url.split('?')[0]));
  const ordered = fresh.concat(stale);

  // 多源轮流出，避免全是同一个站的图
  const buckets = new Map();
  for (const it of ordered) {
    if (!buckets.has(it.source)) buckets.set(it.source, []);
    buckets.get(it.source).push(it);
  }
  const mixed = [];
  let more = true;
  while (more && mixed.length < n) {
    more = false;
    for (const list of buckets.values()) {
      const next = list.shift();
      if (next) { mixed.push(next); more = true; }
      if (mixed.length >= n) break;
    }
  }
  for (const it of mixed) markServed(it.url.split('?')[0]);
  return mixed;
}

async function imageSearch({ query, count = 6, source = 'all', page } = {}) {
  const q = clip(query, 40);
  if (!q) throw new Error('query 不能为空');
  const list = await collectImages(q, count, source, page);
  if (!list.length) return `没搜到「${q}」的图片。`;
  return `「${q}」搜到 ${list.length} 张：\n` + list.map((it, i) =>
    `${i + 1}. [${it.source}] ${it.title ? clip(it.title, 30) + ' · ' : ''}${it.url}`,
  ).join('\n');
}

async function imagePost({ key, query, count = 2, source = 'all', page } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  const q = clip(query, 40);
  if (!q) throw new Error('query 不能为空');
  const gateMsg = imgGateCheck(key);
  if (gateMsg) return gateMsg;
  const n = Math.max(1, Math.min(6, Number(count) || 2));
  const list = await collectImages(q, n, source, page);
  if (!list.length) return `没搜到「${q}」的图片。`;

  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  let sent = 0, failed = 0;
  for (const it of list) {
    const payload = kind === 'group'
      ? { group_id: Number(target), message: [{ type: 'image', data: { file: `base64://${(await fetchImageBuffer(it.url)).toString('base64')}` } }] }
      : { user_id: Number(target), message: [{ type: 'image', data: { file: `base64://${(await fetchImageBuffer(it.url)).toString('base64')}` } }] };
    try {
      await onebotCall(action, payload);
      sent += 1;
    } catch (error) {
      failed += 1;
      log('image send failed:', error?.message ?? error);
    }
  }
  if (sent > 0) imgGateMark(key, sent);
  return `「${q}」发了 ${sent} 张到 ${key}${failed ? `（${failed} 张发送失败）` : ''}｜来源：${[...new Set(list.map((x) => x.source))].join('/')}`;
}

// ── 表情包 ───────────────────────────────────────────────────────────
// 素材：anka-afk/blue-fat-fish-meme-pack v1.0.0（157 张，按 15 个语义分类）。
// 服务端只存了每类最小的几张（省流量），按类随机发。
const STICKER_ROOT = `${ROOT}/stickers/fatfish`;
const STICKER_CATS = {
  happy: '开心/庆祝/满分/期待好消息',
  angry: '生气/责备/夸张玩笑式威胁',
  sad: '哭/委屈/受挫/倒下',
  confused: '发呆/问号/思考/头晕',
  surprised: '惊吓/害怕/紧张/冒汗',
  shy: '害羞/脸红/眨眼卖萌',
  sleep: '困/睡觉/休息/吹风放松',
  affection: '爱心/送礼/摸头/安慰/亲近',
  food: '开饭/吃零食/喝饮料/馋嘴',
  money: '刷卡/撒钱/红包/要米',
  greeting: '到达/冒泡/打招呼/喊话',
  work: '工作/打字/电脑故障/加班摸鱼',
  entertainment: '唱歌/吉他/舞蹈/游戏/应援',
  teasing: '小丑/自嘲/装酷/恶搞/嫌弃',
  reply: '说话/否定/差评/按按钮/摇头',
};

let stickerIndex = null;
function loadStickers() {
  if (stickerIndex) return stickerIndex;
  stickerIndex = new Map();
  try {
    for (const cat of readdirSync(STICKER_ROOT, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue;
      const dir = join(STICKER_ROOT, cat.name);
      const files = readdirSync(dir).filter((f) => /\.gif$/i.test(f)).map((f) => join(dir, f));
      if (files.length) stickerIndex.set(cat.name, files);
    }
  } catch {
    /* 目录不存在就当空 */
  }
  return stickerIndex;
}

function stickerList({ category } = {}) {
  const idx = loadStickers();
  if (!idx.size) return '表情包还没装。';
  const cat = String(category ?? '').trim().toLowerCase();
  if (cat) {
    const files = idx.get(cat);
    if (!files) return `没有「${cat}」这一类。可选：${[...idx.keys()].join(' / ')}`;
    return `「${cat}」共 ${files.length} 张（${STICKER_CATS[cat] ?? ''}）：\n` +
      files.map((f) => '  ' + basename(f).replace(/\.gif$/i, '')).join('\n');
  }
  return '表情包分类：\n' + [...idx.entries()].map(([c, fs]) =>
    `  ${c}（${fs.length} 张）：${STICKER_CATS[c] ?? ''}`,
  ).join('\n') + '\n\n发的时候用 sticker_send，category 填上面某个英文名。';
}

async function stickerSend({ key, category = 'happy', count = 1, name } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  const idx = loadStickers();
  if (!idx.size) return '表情包还没装。';

  let pool;
  const cat = String(category).toLowerCase();
  if (name) {
    const needle = String(name);
    pool = [...idx.values()].flat().filter((f) => basename(f).includes(needle));
  } else {
    pool = idx.get(cat) ?? [];
  }
  if (!pool.length) return `没有匹配的表情（category=${category}${name ? `, name=${name}` : ''}）。先调 sticker_list 看看有哪些。`;

  const n = Math.max(1, Math.min(3, Number(count) || 1));
  const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, n);
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const sentNames = [];
  for (const file of picked) {
    const b64 = readFileSync(file).toString('base64');
    const payload = kind === 'group'
      ? { group_id: Number(target), message: [{ type: 'image', data: { file: `base64://${b64}` } }] }
      : { user_id: Number(target), message: [{ type: 'image', data: { file: `base64://${b64}` } }] };
    await onebotCall(action, payload);
    sentNames.push(basename(file).replace(/\.gif$/i, ''));
  }
  return `发到 ${key}：${sentNames.join('、')}（${category}）`;
}

// ── B站推荐 ────────────────────────────────────────────────────────────────
// 实测服务器直连 B站公开接口即可（热门/排行/搜索都 code 0），不需要登录态。
const fmtCount = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
};
const fmtDur = (s) => {
  const n = Number(s) || 0;
  const m = Math.floor(n / 60);
  return `${m}:${String(n % 60).padStart(2, '0')}`;
};

// B站对无 cookie 的请求会回 412（风控）。先访问首页拿 buvid3 等 cookie，再带上去。
let biliJar = { value: '', at: 0 };
const BILI_ACCOUNT = `${ROOT}/bili-account.json`;

// 登录过的账号 cookie（扫码登录写入）；没有才回落游客 buvid3
function biliAccountCookie() {
  try {
    const j = JSON.parse(readFileSync(BILI_ACCOUNT, 'utf8'));
    return String(j?.cookie ?? '').trim();
  } catch { return ''; }
}

async function biliCookie(force = false) {
  const account = biliAccountCookie();
  if (account) return account;
  if (!force && biliJar.value && Date.now() - biliJar.at < 10 * 60 * 1000) return biliJar.value;
  const res = await fetch('https://www.bilibili.com/', {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  biliJar = { value: list.map((c) => c.split(';')[0]).filter(Boolean).join('; '), at: Date.now() };
  return biliJar.value;
}

async function biliGet(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookie = await biliCookie(attempt > 0);
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        origin: 'https://www.bilibili.com',
        ...(cookie ? { cookie } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 412) continue;      // 风控页：换一次 cookie 重试
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  }
  return null;
}

async function biliRecommend({ mode = 'popular', keyword, rid = 0, limit = 5 } = {}) {
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const B = 'https://api.bilibili.com';
  let items = [];

  const m = String(mode).toLowerCase();
  if (m === 'search') {
    const kw = clip(keyword, 40);
    if (!kw) throw new Error('search 模式需要 keyword');
    const d = await biliGet(`${B}/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&page=1`);
    items = (d?.data?.result ?? []).map((x) => ({
      title: stripTags(String(x?.title ?? '')),
      up: x?.author,
      view: x?.play,
      dur: x?.duration,          // "12:34" 字符串
      bvid: x?.bvid,
    }));
  } else if (m === 'ranking') {
    const d = await biliGet(`${B}/x/web-interface/ranking/v2?rid=${Number(rid) || 0}&type=all`);
    items = (d?.data?.list ?? []).map((x) => ({
      title: x?.title, up: x?.owner?.name, view: x?.stat?.view,
      durSec: x?.duration, bvid: x?.bvid,
    }));
  } else {
    const d = await biliGet(`${B}/x/web-interface/popular?ps=${n + 5}&pn=1`);
    items = (d?.data?.list ?? []).map((x) => ({
      title: x?.title, up: x?.owner?.name, view: x?.stat?.view,
      durSec: x?.duration, bvid: x?.bvid,
    }));
  }

  items = items.filter((x) => x.title && x.bvid);
  if (!items.length) return 'B站那边没拿到视频。';
  // popular/ranking 是固定榜，随机切片避免每次都推同几条
  if (m !== 'search') items = shuffle(items);
  items = items.slice(0, n);

  const label = m === 'search' ? `搜索「${keyword}」` : m === 'ranking' ? '全站排行榜' : '热门推荐';
  return `B站${label}（${items.length} 条）：\n` + items.map((x, i) => {
    // 搜索结果里的 duration 是 B站 给的 "5:6" 这种字符串，补零成 5:06
    let dur = x.dur ? String(x.dur).replace(/^(\d+):(\d)$/, '$1:0$2') : (x.durSec ? fmtDur(x.durSec) : '');
    return `${i + 1}. ${clip(x.title, 40)} — ${x.up ?? '?'}｜${fmtCount(x.view)}播放${dur ? `｜${dur}` : ''}\n   https://www.bilibili.com/video/${x.bvid}`;
  }).join('\n');
}

// ── 图库（随机图 API 收集）─────────────────────────────────────────────────
// 来源：https://imgapi.lie.moe/random（302 跳到 imghost 的 jpg）。
// 落地：gallery/*.jpg + index.json；同 sha256 不重复存。
const GALLERY_DIR = `${ROOT}/gallery`;
const GALLERY_INDEX = join(GALLERY_DIR, 'index.json');
const GALLERY_API = 'https://imgapi.lie.moe/random';
const GALLERY_MAX_EDGE = 1600;
const GALLERY_SOURCE = 'imgapi.lie.moe';

function galleryIndex() {
  try { return JSON.parse(readFileSync(GALLERY_INDEX, 'utf8')); } catch { return { items: [] }; }
}
function saveGalleryIndex(idx) {
  mkdirSync(GALLERY_DIR, { recursive: true });
  const tmp = `${GALLERY_INDEX}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx, null, 1));
  renameSync(tmp, GALLERY_INDEX);
}
function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return '';
}

// 缩到长边 1600 再存：原图常 3–8MB，收缩后 200–500KB，图库和发 QQ 都轻松。
async function shrinkToJpeg(srcPath, dstPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', srcPath,
    '-vf', `scale='min(${GALLERY_MAX_EDGE},iw)':-2`,
    '-q:v', '3', dstPath,
  ], { timeout: 60000 });
  return statSync(dstPath).size;
}

async function galleryCollect({ count = 5 } = {}) {
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  mkdirSync(GALLERY_DIR, { recursive: true });
  const idx = galleryIndex();
  const seen = new Set(idx.items.map((x) => x.sha256));
  const added = [];
  const skipped = [];
  let failed = 0;

  for (let i = 0; i < n; i += 1) {
    try {
      const res = await fetch(GALLERY_API, {
        headers: { 'user-agent': UA, accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) { failed += 1; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 20 * 1024 || buf.length > 30 * 1024 * 1024) { failed += 1; continue; }
      const kind = sniffImage(buf);
      if (!kind) { failed += 1; continue; }

      const sha = createHash('sha256').update(buf).digest('hex');
      if (seen.has(sha)) { skipped.push('dup'); continue; }
      seen.add(sha);

      const id = sha.slice(0, 12);
      const rawPath = join(GALLERY_DIR, `.raw-${id}.${kind}`);
      const outPath = join(GALLERY_DIR, `${id}.jpg`);
      writeFileSync(rawPath, buf);
      let bytes;
      try {
        bytes = await shrinkToJpeg(rawPath, outPath);
      } catch (error) {
        log('shrink failed, keep original:', error?.message ?? error);
        renameSync(rawPath, join(GALLERY_DIR, `${id}.${kind}`));
        bytes = buf.length;
      }
      try { if (existsSync(rawPath)) renameSync(rawPath, `/tmp/.gallery-raw-${id}`); } catch { /* ignore */ }

      added.push({ id, file: `${id}.jpg`, sha256: sha, bytes, source: GALLERY_SOURCE, url: res.url, at: new Date().toISOString() });
    } catch (error) {
      failed += 1;
      log('collect failed:', error?.message ?? error);
    }
    await new Promise((r) => setTimeout(r, 300));   // 接口有配额，别打太快
  }

  idx.items.push(...added);
  saveGalleryIndex(idx);
  const lines = [`本次收集 ${added.length} 张（去重跳过 ${skipped.length}，失败 ${failed}）`];
  if (added.length) lines.push(...added.map((x) => `  ${x.id}  ${Math.round(x.bytes / 1024)}KB`));
  lines.push(`图库合计 ${idx.items.length} 张`);
  return lines.join('\n');
}

async function galleryList({ limit = 10, offset = 0 } = {}) {
  const idx = galleryIndex();
  const total = idx.items.length;
  if (!total) return '图库是空的，先 gallery_collect 收几张。';
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  const off = Math.max(0, Number(offset) || 0);
  const page = idx.items.slice().reverse().slice(off, off + n);
  return `图库 ${total} 张（按时间倒序，offset=${off}）：\n` + page.map((x, i) =>
    `${off + i + 1}. ${x.id}｜${Math.round(x.bytes / 1024)}KB｜${String(x.at).slice(0, 16).replace('T', ' ')}`,
  ).join('\n');
}

async function gallerySend({ key, count = 1, id } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  const gateMsg = imgGateCheck(key);
  if (gateMsg) return gateMsg;
  const idx = galleryIndex();
  if (!idx.items.length) return '图库是空的。';
  let picks;
  if (id) {
    picks = idx.items.filter((x) => String(x.id).startsWith(String(id)));
    if (!picks.length) return `图库里没有 id=${id}。`;
  } else {
    const n = Math.max(1, Math.min(5, Number(count) || 1));
    picks = idx.items.slice().sort(() => Math.random() - 0.5).slice(0, n);
  }

  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  let sent = 0;
  for (const it of picks) {
    const path = join(GALLERY_DIR, it.file);
    if (!existsSync(path)) continue;
    const b64 = readFileSync(path).toString('base64');
    const payload = kind === 'group'
      ? { group_id: Number(target), message: [{ type: 'image', data: { file: `base64://${b64}` } }] }
      : { user_id: Number(target), message: [{ type: 'image', data: { file: `base64://${b64}` } }] };
    await onebotCall(action, payload);
    sent += 1;
  }
  if (sent > 0) imgGateMark(key, sent);
  return `从图库发了 ${sent} 张到 ${key}（${picks.map((x) => x.id).join('、')}）`;
}

// ── 文档读取（PDF / Excel / Word / 文本）───────────────────────────────────
const DOC_DIR = `${ROOT}/doc-tmp`;
const DOC_EXTRACT = `${ROOT}/doc_extract.py`;
const DOC_EXTS = ['.pdf', '.xlsx', '.xls', '.docx', '.txt', '.md', '.csv', '.json', '.tsv', '.log'];
const DOC_MAX_BYTES = 60 * 1024 * 1024;

const docExt = (name) => {
  const clean = String(name ?? '').split('?')[0].split('#')[0];
  const m = /(\.[a-z0-9]+)$/i.exec(clean);
  return m ? m[1].toLowerCase() : '';
};

// 从 QQ 拿文件：群文件走 get_group_file_url，私聊走 get_private_file_url
async function resolveQqFileUrl({ groupId, fileId, fileHash, userId, busid }) {
  if (!fileId) throw new Error('缺少 fileId');
  if (groupId) {
    const data = await onebotCall('get_group_file_url', {
      group_id: Number(groupId), file_id: String(fileId), ...(busid ? { busid: String(busid) } : {}),
    });
    const url = data?.url ?? data?.file_url ?? data?.download_url;
    if (!url) throw new Error(`群文件没拿到下载链接（${JSON.stringify(data).slice(0, 120)}）`);
    return url;
  }
  if (!userId) throw new Error('私聊文件需要 userId');
  const data = await onebotCall('get_private_file_url', {
    user_id: Number(userId), file_id: String(fileId), file_hash: String(fileHash ?? ''),
  });
  const url = data?.url ?? data?.file_url ?? data?.download_url;
  if (!url) throw new Error(`私聊文件没拿到下载链接（${JSON.stringify(data).slice(0, 120)}）`);
  return url;
}

async function docRead({ url, path: localPath, groupId, fileId, fileHash, userId, busid, maxChars = 20000 } = {}) {
  const limit = Math.max(500, Math.min(60000, Number(maxChars) || 20000));
  mkdirSync(DOC_DIR, { recursive: true });

  let srcUrl = String(url ?? '').trim();
  let srcPath = String(localPath ?? '').trim();
  if (!srcUrl && !srcPath) srcUrl = await resolveQqFileUrl({ groupId, fileId, fileHash, userId, busid });

  let buf, name;
  if (srcUrl) {
    name = decodeURIComponent((srcUrl.split('?')[0].split('/').pop() || 'download'));
    const res = await fetch(srcUrl, {
      headers: { 'user-agent': UA, ...(srcUrl.includes('qq.com') ? { referer: 'https://qun.qq.com/' } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    // 有些直链不带扩展名：从 Content-Disposition 里补
    const cd = res.headers.get('content-disposition') ?? '';
    const cdm = /filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i.exec(cd);
    if (cdm && !DOC_EXTS.includes(docExt(name))) name = decodeURIComponent(cdm[1]);
  } else {
    if (!existsSync(srcPath)) throw new Error(`本地路径不存在：${srcPath}`);
    buf = readFileSync(srcPath);
    name = basename(srcPath);
  }

  if (buf.length > DOC_MAX_BYTES) throw new Error(`文件太大（${Math.round(buf.length / 1048576)}MB，上限 60MB）`);
  let ext = docExt(name);
  if (!DOC_EXTS.includes(ext)) {
    // 按魔数兜底
    if (buf.slice(0, 4).toString('latin1') === '%PDF') ext = '.pdf';
    else if (buf[0] === 0x50 && buf[1] === 0x4b) ext = '.xlsx';   // zip 容器，xlsx/docx 都是
  }
  if (!DOC_EXTS.includes(ext)) throw new Error(`不认识的文件类型「${name}」，支持 ${DOC_EXTS.join(' ')}`);

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = join(DOC_DIR, `${stamp}${ext}`);
  writeFileSync(tmp, buf);

  try {
    const { stdout } = await execFileAsync(PY, [DOC_EXTRACT, tmp, '--max-chars', String(limit)], {
      timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    const kb = buf.length / 1024;
    const sizeLabel = kb < 1 ? `${buf.length}B` : `${Math.round(kb)}KB`;
    const head = `【${name}】${ext.slice(1).toUpperCase()} · ${sizeLabel}\n`;
    const body = stdout.trim() || '（没提取到文本，可能是扫描版/图片型文档）';
    return head + body;
  } catch (error) {
    const msg = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 300);
    throw new Error(`解析失败：${msg}`);
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── 造文件 + 发文件 ────────────────────────────────────────────────────────
// SnowLuma 的 upload_group_file / upload_private_file 直接吃 base64://，
// 所以宿主侧生成的内容不必先塞进容器。
const DOC_MAKE = `${ROOT}/doc_make.py`;
const FILE_MAX_BYTES = 60 * 1024 * 1024;

async function sendFileToChat({ kind, target, buffer, name }) {
  if (buffer.length > FILE_MAX_BYTES) throw new Error(`文件太大（${Math.round(buffer.length / 1048576)}MB，上限 60MB）`);
  const b64 = `base64://${buffer.toString('base64')}`;
  const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file';
  const payload = kind === 'group'
    ? { group_id: Number(target), file: b64, name, upload_file: true }
    : { user_id: Number(target), file: b64, name, upload_file: true };
  const data = await onebotCall(action, payload);
  return data?.file_id ?? data?.data?.file_id ?? '';
}

function parseKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  return { kind: m[1], target: m[2] };
}

// 把 rows 或多行文本变成 csv 文本
function toCsv(rows, header) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => (Array.isArray(r) ? r : [r]).map(esc).join(','));
  return (header ? [header.map(esc).join(',')] : []).concat(body).join('\n') + '\n';
}

async function fileMake({ key, name, format = 'csv', content, rows, sheet = 'Sheet1', header, title, subtitle, blocks, slides, theme, cover } = {}) {
  const { kind, target } = parseKey(key);
  const fmt = String(format).toLowerCase();
  const fileName = String(name ?? `qq-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
  let buffer;

  if (fmt === 'csv') {
    const data = rows?.length ? rows : (content ? String(content).split('\n').map((l) => l.split(',')) : null);
    if (!data) throw new Error('csv 需要 rows 或 content');
    buffer = Buffer.from(toCsv(data, header), 'utf8');
  } else if (fmt === 'xlsx') {
    const data = rows?.length ? rows : (content ? String(content).split('\n').map((l) => l.split(',')) : null);
    if (!data) throw new Error('xlsx 需要 rows 或 content');
    const allRows = header ? [header, ...data] : data;
    mkdirSync(DOC_DIR, { recursive: true });
    const tmp = join(DOC_DIR, `make-${Date.now()}.xlsx`);
    try {
      const child = execFile(PY, [DOC_MAKE, tmp], { timeout: 60000 }, () => {});
      child.stdin.end(JSON.stringify({ sheet, rows: allRows }));
      await new Promise((resolve, reject) => {
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`doc_make 退出码 ${code}`))));
        child.on('error', reject);
      });
      buffer = readFileSync(tmp);
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  } else if (fmt === 'docx' || fmt === 'pptx') {
    // 两种输入：markdown-ish 的 content，或结构化 blocks/slides
    const themeObj = (() => {
      if (!theme) return undefined;
      if (typeof theme === 'string') { try { return JSON.parse(theme); } catch { return undefined; } }
      return theme;
    })();
    const payload = fmt === 'docx'
      ? { kind: 'docx', title: name || '文档', blocks: markdownToBlocks(String(content ?? '')) }
      : { kind: 'pptx', title: name || '幻灯片', slides: markdownToSlides(String(content ?? '')), theme: themeObj, cover };
    if (blocks) Object.assign(payload, { blocks });
    if (slides) Object.assign(payload, { slides });
    if (typeof title === 'string' && title.trim()) payload.title = title.trim();
    if (typeof subtitle === 'string' && subtitle.trim()) payload.subtitle = subtitle.trim();
    mkdirSync(DOC_DIR, { recursive: true });
    const tmp = join(DOC_DIR, `make-${Date.now()}.${fmt}`);
    try {
      const child = execFile(PY, [OFFICE_MAKE, tmp], { timeout: 90000 }, () => {});
      child.stdin.end(JSON.stringify(payload));
      await new Promise((resolve, reject) => {
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`office_make 退出码 ${code}`))));
        child.on('error', reject);
      });
      buffer = readFileSync(tmp);
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  } else if (['txt', 'md', 'json'].includes(fmt)) {
    if (content == null) throw new Error(`${fmt} 需要 content`);
    buffer = Buffer.from(String(content), 'utf8');
  } else {
    throw new Error(`不支持的格式「${format}」，可选 csv / xlsx / txt / md / json`);
  }

  const finalName = fileName.includes('.') ? fileName : `${fileName}.${fmt}`;
  const fileId = await sendFileToChat({ kind, target, buffer, name: finalName });
  return `已发到 ${key}：${finalName}（${buffer.length < 1024 ? `${buffer.length}B` : `${Math.round(buffer.length / 1024)}KB`}，file_id ${String(fileId).slice(0, 24)}…）`;
}

async function fileSend({ key, path: localPath, url, name } = {}) {
  const { kind, target } = parseKey(key);
  let buffer, fileName = name;
  if (url) {
    const res = await fetch(String(url), { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    fileName = fileName ?? decodeURIComponent((String(url).split('?')[0].split('/').pop() || 'file'));
  } else if (localPath) {
    if (!existsSync(localPath)) throw new Error(`路径不存在：${localPath}`);
    buffer = readFileSync(localPath);
    fileName = fileName ?? basename(localPath);
  } else {
    throw new Error('需要 path 或 url');
  }
  const fileId = await sendFileToChat({ kind, target, buffer, name: fileName });
  return `已发到 ${key}：${fileName}（${buffer.length < 1024 ? `${buffer.length}B` : `${Math.round(buffer.length / 1024)}KB`}，file_id ${String(fileId).slice(0, 24)}…）`;
}

// ── Pixiv ──────────────────────────────────────────────────────────────────
// 两条通道：
// ① 直连 pixiv.net 的 web ajax 搜索 —— 需要出口，走 SSH 反向隧道到本机代理（127.0.0.1:19081），
//    匿名即可搜（不需要登录），结果带 xRestrict 分级字段。
// ② pixiv.yuki.sh —— 随机推荐 + 匿名原图（/{id}），当 ① 不可用时兜底。
const PIXIV_BASE = 'https://pixiv.yuki.sh';
const PIXIV_PROXY = process.env.PIXIV_PROXY ?? 'http://127.0.0.1:19081';
const pixivPool = new Map();   // id -> work（①失败时用）

let pixivAgent = null;
function pixivDispatcher() {
  if (!pixivAgent) pixivAgent = new ProxyAgent(PIXIV_PROXY);
  return pixivAgent;
}

// 走代理抓 pixiv.net 的 ajax 接口
async function pixivAjax(url, timeout = 20000) {
  // 先探一下隧道端口，省得等 20 秒超时
  const ok = await new Promise((resolve) => {
    const px = (() => { try { return new URL(PIXIV_PROXY); } catch { return null; } })();
    const sock = net.connect(Number(px?.port) || 19081, px?.hostname || '127.0.0.1');
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(1200);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
  if (!ok) {
    throw new Error('pixiv 需要代理隧道（127.0.0.1:19081），当前不通。把 VPN/隧道打开再试。');
  }
  const res = await proxyFetch(url, {
    dispatcher: pixivDispatcher(),
    headers: {
      'user-agent': UA,
      referer: 'https://www.pixiv.net/',
      'accept': 'application/json',
      'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8',
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`pixiv HTTP ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text);
  if (json?.error) throw new Error(`pixiv 返回错误：${JSON.stringify(json).slice(0, 120)}`);
  return json;
}

// 单作品详情：拿收藏数（列表接口不给）
async function pixivMeta(id) {
  try {
    const j = await pixivAjax(`https://www.pixiv.net/ajax/illust/${id}`);
    const b = j?.body ?? {};
    return { bookmarkCount: Number(b.bookmarkCount) || 0, width: Number(b.width) || 0, height: Number(b.height) || 0 };
  } catch { return { bookmarkCount: 0, width: 0, height: 0 }; }
}

// 并发补全收藏数（限制并发 4，避免触发风控）
async function pixivEnrich(list, want = 12) {
  const head = list.slice(0, want);
  const out = [];
  for (let i = 0; i < head.length; i += 4) {
    const batch = head.slice(i, i + 4);
    const metas = await Promise.all(batch.map((w) => pixivMeta(w.id)));
    batch.forEach((w, k) => out.push({ ...w, ...metas[k] }));
    await new Promise((r) => setTimeout(r, 120));
  }
  return out.concat(list.slice(want));
}

// 关键词搜索（真正的搜索，不是抽池子猜）
async function pixivKeyword(word, page = 1, mode = 'all') {
  const w = encodeURIComponent(word);
  const j = await pixivAjax(`https://www.pixiv.net/ajax/search/artworks/${w}?word=${w}&p=\${page}&mode=\${mode}&lang=zh`);
  const list = j?.body?.illustManga?.data ?? [];
  return list.map((x) => ({
    id: String(x.id),
    title: String(x.title ?? ''),
    author: String(x.userName ?? ''),
    tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
    xRestrict: Number(x.xRestrict) || 1,
    bookmarkCount: Number(x.bookmarkCount) || 0,
    width: Number(x.width) || 0,
    height: Number(x.height) || 0,
    // 优先用 ajax 给的原始路径（i.pximg.net）改写成 i.pixiv.re；没有就退回 yuki
    url: (() => {
      const raw = String(x.url ?? '');
      if (raw.includes('i.pximg.net')) return 'https://i.pixiv.re' + raw.split('i.pximg.net')[1];
      return `${PIXIV_BASE}/${x.id}`;
    })(),
  }));
}

async function pixivDraw(n = 6) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    try {
      const d = await getJSON(`${PIXIV_BASE}/api/recommend?type=json&size=regular`, {
        headers: { referer: `${PIXIV_BASE}/` }, timeout: 15000,
      });
      const w = d?.data;
      if (!w?.id) continue;
      const work = {
        id: String(w.id),
        title: String(w.title ?? ''),
        author: String(w?.user?.name ?? ''),
        tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
        width: Number(w.width) || 0,
        height: Number(w.height) || 0,
        url: `${PIXIV_BASE}/${w.id}`,          // 匿名可下原图
      };
      if (!pixivPool.has(work.id)) out.push(work);
      pixivPool.set(work.id, work);
    } catch (error) {
      log('pixiv draw failed:', error?.message ?? error);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (pixivPool.size > 300) {
    const keep = new Set([...pixivPool.keys()].slice(-300));
    for (const k of [...pixivPool.keys()]) if (!keep.has(k)) pixivPool.delete(k);
  }
  return out;
}

function pixivMatch(query) {
  const toks = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = [...pixivPool.values()];
  if (!toks.length) return all;
  return all.filter((w) => {
    const hay = `${w.title} ${w.tags.join(' ')} ${w.author}`.toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}

async function pixivSearch({ query, count = 5, page = 1, safeOnly = false, sort = 'popular', r18 = false } = {}) {
  const mode = r18 ? 'r18' : 'all';
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  const kw = String(query ?? '').trim();

  // ① 有出口时走真正的关键词搜索
  if (kw) {
    try {
      const pageN = Math.max(1, Math.min(20, Number(page) || 1));
      let list = await pixivKeyword(kw, pageN, mode);
      let filtered = safeOnly ? list.filter((w) => w.xRestrict === 0) : list;
      if (filtered.length) {
        let picks;
        if (String(sort) === 'popular') {
          // 搜索结果默认按时间排，单页收藏数都偏低；合并前 3 页再按收藏挑
          for (const p2 of [2, 3]) {
            try { list = list.concat(await pixivKeyword(kw, p2, mode)); } catch { /* 翻页失败就跳过 */ }
          }
          const uniq = [...new Map(list.map((w) => [w.id, w])).values()];
          filtered = safeOnly ? uniq.filter((w) => w.xRestrict === 0) : uniq;
          const enriched = await pixivEnrich(filtered, 24);
          picks = [...enriched].sort((a, b) => (b.bookmarkCount || 0) - (a.bookmarkCount || 0)).slice(0, n);
        } else {
          picks = filtered.slice(0, n);
        }
        return `Pixiv 搜索「${kw}」第 ${pageN} 页，命中 ${filtered.length} 件（总 ${list.length}）${sort === 'popular' ? '· 按收藏排序' : ''}：\n` + picks.map((w, i) =>
          `${i + 1}. ${clip(w.title || '(无题)', 30)} — ${w.author}｜${w.width}×${w.height}｜收藏 ${w.bookmarkCount || 0}｜${w.tags.slice(0, 4).join('、')}\n   ${w.url}`,
        ).join('\n');
      }
      if (!list.length) return `Pixiv 搜「${kw}」没有结果。`;
      return `Pixiv 搜「${kw}」有 ${list.length} 件，但都被分级过滤掉了（xRestrict≠0）。`;
    } catch (error) {
      log('pixiv keyword search failed:', error?.message ?? error);
      // 隧道不通就别退到 yuki.sh 随机池了——那批图大量 403，发出去也是空的
      if (/隧道|19081/.test(String(error?.message ?? ''))) {
        return 'pixiv 官方搜索需要代理隧道（127.0.0.1:19081），现在不通。'
          + '把 VPN 打开后我再试；这期间可以用 pixivic 搜（不需要隧道）。';
      }
      // 其它错误落到 ② 兜底
    }
  }

  // ② 兜底：yuki.sh 随机池
  const batch = 8;
  await pixivDraw(batch);
  let hits = kw ? pixivMatch(kw) : [...pixivPool.values()];
  if (!hits.length && kw) {
    await pixivDraw(batch * 2);
    hits = pixivMatch(kw);
  }
  const list = (hits.length ? hits : [...pixivPool.values()]).slice(0, n);
  if (!list.length) return '没抽到作品，稍后再试。';
  const note = kw && !hits.length
    ? `\n（直连 pixiv 失败，随机池里也没抽到含「${kw}」的作品，先给几张随机的）`
    : '\n（直连 pixiv 不可用，用的是 yuki.sh 随机池）';
  return `Pixiv 随机池 ${pixivPool.size} 件，返回 ${list.length} 件：\n` + list.map((w, i) =>
    `${i + 1}. ${clip(w.title || '(无题)', 30)} — ${w.author}｜${w.width}×${w.height}｜${w.tags.slice(0, 4).join('、')}\n   ${w.url}`,
  ).join('\n') + note;
}

async function pixivSend({ key, query, count = 1, safeOnly = false, r18 = false } = {}) {
  const mode = r18 ? 'r18' : 'all';
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  const n = Math.max(1, Math.min(3, Number(count) || 1));
  const kw = String(query ?? '').trim();

  let picks = [];
  if (kw) {
    try {
      const list = await pixivKeyword(kw, 1, mode);
      const filtered = safeOnly ? list.filter((w) => w.xRestrict === 0) : list;
      picks = filtered.slice().sort(() => Math.random() - 0.5).slice(0, n);
    } catch (error) {
      log('pixiv keyword search failed (send):', error?.message ?? error);
    }
  }
  if (!picks.length) {
    let hits = kw ? pixivMatch(kw) : [...pixivPool.values()];
    if (hits.length < n) { await pixivDraw(8); hits = kw ? pixivMatch(kw) : [...pixivPool.values()]; }
    picks = hits.slice().sort(() => Math.random() - 0.5).slice(0, n);
  }
  if (!picks.length) return `没找到可发的作品${kw ? `（关键词「${kw}」）` : ''}。`;

  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  let sent = 0;
  for (const w of picks) {
    const payload = kind === 'group'
      ? { group_id: Number(target), message: [{ type: 'image', data: { file: w.url } }] }
      : { user_id: Number(target), message: [{ type: 'image', data: { file: w.url } }] };
    try { await onebotCall(action, payload); sent += 1; } catch (e) { log('pixiv send failed:', e?.message ?? e); }
  }
  return `从 Pixiv 发了 ${sent} 张到 ${key}（${picks.map((w) => w.id).join('、')}）`;
}

// ── QQ 空间说说 ────────────────────────────────────────────────────────────
// SnowLuma 自带 send_qzone_msg（发表说说），ugc_right: 1=公开 4=好友 16/128=指定人（需 target_uins）
const DIARY_DIR = `${ROOT}/diary`;

async function qzonePost({ content, images, ugcRight = 1, targetUins } = {}) {
  const text = String(content ?? '').trim();
  if (!text) throw new Error('content 不能为空');
  if (text.length > 2000) throw new Error(`说说太长（${text.length} 字，上限 2000）`);

  const payload = { content: text, ugc_right: Number(ugcRight) || 1 };
  if (Array.isArray(images) && images.length) payload.images = images.map(String);
  if (Array.isArray(targetUins) && targetUins.length) payload.target_uins = targetUins.map(Number);

  const data = await onebotCall('send_qzone_msg', payload);

  // 顺手存档，方便以后回顾（不参与发送逻辑）
  try {
    mkdirSync(DIARY_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = join(DIARY_DIR, `${day}.md`);
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, `${prev}${prev ? '\n\n---\n\n' : ''}## ${new Date().toISOString()}\n${text}\n`);
  } catch (error) {
    log('diary archive failed:', error?.message ?? error);
  }

  return `已发到 QQ 空间（tid ${data?.tid ?? '?'}，权限 ${payload.ugc_right}，${text.length} 字）`;
}

async function diaryList({ limit = 7 } = {}) {
  try {
    const files = readdirSync(DIARY_DIR).filter((f) => f.endsWith('.md')).sort().reverse();
    if (!files.length) return '还没有日记存档。';
    const n = Math.max(1, Math.min(30, Number(limit) || 7));
    const picked = files.slice(0, n);
    return picked.map((f) => {
      const body = readFileSync(join(DIARY_DIR, f), 'utf8');
      return `【${f.replace('.md', '')}】${body.length} 字\n${clip(body, 200)}`;
    }).join('\n\n');
  } catch {
    return '还没有日记存档。';
  }
}

// ── Pixivic（pixivic.com / pix.ipv4.host）───────────────────────────────────
// 前端 pixivic.com 是 SPA，真正的 API 在 https://pix.ipv4.host。
// 搜索接口 /illustrations 需要登录态（匿名 → 401 {"message":"账户未登录"}），
// 所以 token 放 pixivic.json（{"token":"..."}）。
const PIXIVIC_API = 'https://pix.ipv4.host';
const PIXIVIC_CONF = `${ROOT}/pixivic.json`;

function pixivicToken() {
  if (process.env.PIXIVIC_TOKEN) return String(process.env.PIXIVIC_TOKEN);
  try {
    const c = JSON.parse(readFileSync(PIXIVIC_CONF, 'utf8'));
    return String(c?.token ?? c?.accessToken ?? '');
  } catch {
    return '';
  }
}

const PIXIVIC_HINT = 'pixivic 需要登录态：浏览器登录 pixivic.com → F12 → Application → Local Storage 里找 token，'
  + '写进 pixivic.json 形如 {"token":"…"} 后重试。';

// 解析 pixivic JWT 的过期时间，用来给「token 过期」这种明确提示
function pixivicTokenInfo(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!json?.exp) return null;
    return {
      userId: json.userId,
      exp: new Date(json.exp * 1000),
      hoursLeft: (json.exp * 1000 - Date.now()) / 3600000,
    };
  } catch {
    return null;
  }
}

function pixivicTokenUsable(token) {
  const info = pixivicTokenInfo(token);
  return Boolean(info && info.hoursLeft > 0.05);
}

const PIXIVIC_EXPIRED_MSG =
  'pixivic token 已过期，请重新获取（登录 pixivic.com → F12 → Network → 任一请求的 Authorization → 贴给我）';

async function pixivicFetch(path, token) {
  const url = `${PIXIVIC_API}${path}`;
  const base = { 'user-agent': UA, referer: 'https://pixivic.com/', origin: 'https://pixivic.com' };
  // 鉴权头的几种常见写法都试一遍，哪个通就用哪个
  const variants = [
    { ...base, authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` },
    { ...base, authorization: token },
    { ...base, token },
  ];
  let last = null;
  for (const headers of variants) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    if (res.ok) {
      try { return { json: JSON.parse(text) }; }
      catch { throw new Error(`pixivic 返回非 JSON：${text.slice(0, 80)}`); }
    }
    last = `${res.status} ${text.slice(0, 80)}`;
    if (res.status !== 401) break;      // 不是鉴权问题就别再换头重试
  }
  if (String(last).startsWith('401')) {
    throw new Error(PIXIVIC_EXPIRED_MSG + `（服务端：${last}）`);
  }
  throw new Error(`pixivic 请求失败：${last}`);
}

function normalizePixivicItem(x) {
  const id = String(x?.id ?? '');
  const artist = x?.artistPreView ?? {};
  const urls = Array.isArray(x?.imageUrls) ? x.imageUrls[0] : null;
  const raw = urls?.original ?? urls?.large ?? urls?.medium ?? urls?.squareMedium ?? '';
  const tags = Array.isArray(x?.tags) ? x.tags : [];
  return {
    id,
    type: String(x?.type ?? ''),
    title: String(x?.title ?? ''),
    author: String(artist.name ?? artist.account ?? ''),
    tags: tags.map((t) => (typeof t === 'string' ? t : (t?.translatedName || t?.name || ''))).filter(Boolean),
    width: Number(x?.width) || 0,
    height: Number(x?.height) || 0,
    xrestrict: Number(x?.xrestrict) || 0,
    bookmarks: Number(x?.totalBookmarks) || 0,
    views: Number(x?.totalView) || 0,
    raw,
    // 图源顺序：i.pixiv.re（按原路径改写，最稳）→ yuki.sh（部分 id 403）
    // 注意 i.pximg.net 从机房不可达，必须走镜像
    url: (() => {
      const arr = Array.isArray(x?.imageUrls) ? x.imageUrls : [];
      const first = arr[0] || {};
      const real = first.original || first.large || first.medium || '';
      if (real.includes('i.pximg.net')) return 'https://i.pixiv.re' + real.split('i.pximg.net')[1];
      return id ? `${PIXIV_BASE}/${id}` : raw;
    })(),
    // 发 QQ 用中等尺寸：original 常 2~5MB，i.pixiv.re 拉一张二十多秒；medium 只有几百 KB
    // 发 QQ 用大图（master1200 那种），失败再退 medium
    sendUrl: (() => {
      // pixivic 给的 large 其实是 600px 的 webp，发出去当然糊。
      // 直接拼 master1200（约 1200px、1MB 左右），这是「图片消息」该用的尺寸。
      const arr = Array.isArray(x?.imageUrls) ? x.imageUrls : [];
      const first = arr[0] || {};
      const o = first.original || '';
      if (o.includes('i.pximg.net')) {
        const path = o.split('i.pximg.net')[1].replace('/img-original/', '/img-master/')
          .replace(/_p(\d+)\.(png|jpg|jpeg|gif)$/i, '_p$1_master1200.jpg');
        return 'https://i.pixiv.re' + path;
      }
      const hi = first.large || first.medium || '';
      if (hi.includes('i.pximg.net')) return 'https://i.pixiv.re' + hi.split('i.pximg.net')[1];
      return hi || '';
    })(),
    // 收藏级原图：pixiv 的 original（常见 2000~4000px，单张 2~8MB）
    // 原图：pixiv.re/{id}.png 实测 19MB/10 秒，比 i.pixiv.re 原路径快一倍多；
    // 失败时 chain 里还有 sendUrl（master1200）兜底
    originalUrl: (() => {
      const arr = Array.isArray(x?.imageUrls) ? x.imageUrls : [];
      const first = arr[0] || {};
      const o = first.original || '';
      if (id) return `https://pixiv.re/${id}.png`;
      if (o.includes('i.pximg.net')) return 'https://i.pixiv.re' + o.split('i.pximg.net')[1];
      return o || '';
    })(),
    originalUrlAlt: (() => {
      const arr = Array.isArray(x?.imageUrls) ? x.imageUrls : [];
      const first = arr[0] || {};
      const o = first.original || '';
      if (o.includes('i.pximg.net')) return 'https://i.pixiv.re' + o.split('i.pximg.net')[1];
      return o || '';
    })(),
    sendUrlSmall: (() => {
      const arr = Array.isArray(x?.imageUrls) ? x.imageUrls : [];
      const first = arr[0] || {};
      const lo = first.medium || first.squareMedium || '';
      if (lo.includes('i.pximg.net')) return 'https://i.pixiv.re' + lo.split('i.pximg.net')[1];
      return lo || '';
    })(),
    fallbackUrl: id ? `${PIXIV_BASE}/${id}` : '',
  };
}

function fmtPixivicLine(w, i) {
  const meta = [w.width && `${w.width}×${w.height}`, w.bookmarks && `收藏 ${w.bookmarks}`, w.tags.slice(0, 4).join('、')]
    .filter(Boolean).join('｜');
  return `${i + 1}. ${clip(w.title || '(无题)', 30)} — ${w.author || '?'}｜${meta}\n   ${w.url}`;
}

// pixivic 多页采集：默认抓 3 页 × 50 条，去重后按收藏数排序，池子比单页大得多。
// ── 擦边 tag 池（按实测收藏质量分档，供随机轮换）──────────────────
// 一次只用一个 tag 永远那几张图；随机组合 2~3 个 tag 才能拉开范围。
const PIXIVIC_TAGS = {
  // 零档：明确 R18，被要涩图/R18 时优先从这里抽
  tier0: ['R-18', '中出し', 'おっぱい', '裸', '全裸', 'フェラ', 'パイズリ',
          '断面図', '結合部', '絶頂', '潮吹き', '野外露出', '乱交', '寝取られ',
          '拘束', '調教', 'おもちゃ', 'ぱんつ越し', '乳首', '局部'],
  // 一档：又擦又高赞（中位收藏 3000+），默认从这里抽
  tier1: ['魅惑', 'おへそ', 'ナース', '魅惑のふともも', '体操服', 'ビキニ', '水着',
          '下着', '見上げ', 'ストッキング', '競泳水着', 'レオタード', 'ハイレグ',
          'マイクロビキニ', '腋', 'バニーガール', 'スク水', 'ブルマ', 'ガーターベルト',
          'ブラジャー', 'パンツ', 'チアガール', '尻', '谷間', '透け'],
  // 二档：题材向，质量还行
  tier2: ['裸エプロン', 'フェチ', 'チャイナ', 'シャワー', '寝間着', 'メイド',
          '浴衣', '眼鏡', 'ニーソ', '黒タイツ', 'ボンデージ', '網タイツ',
          '巫女', 'フリル', '濡れ透け', '肩紐', '素足', '裸足'],
  // 三档：构图/局部，用来加重"近景"感
  tier3: ['構図', '接写', '寄り', 'アップ', '振り向き', '寝そべり',
          '四つん這い', '上目遣い', '汗', '腋を見せる', 'ローアングル', 'バストアップ'],
};

// 「来点涩图」这类泛化请求：随机抽 2~3 个 tag 组合，范围比单个词大得多
const GENERIC_ASK = /^(涩图|色图|射图|擦边|好图|来点图|发点图|来几张|随便|随便来|来点|搞点|整点|刺激的|养眼|好看的)$/i;

function expandTagQuery(query, r18 = false) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  // 已经是多个词（空格/、/，/| 分隔）就按多关键词处理
  const parts = q.split(/[\s、,,|]+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 4);
  if (GENERIC_ASK.test(q)) {
    const pickFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const set = new Set();
    // 要 R18 就走零档（明确 R18 tag）；否则维持擦边一档
    if (r18) {
      while (set.size < 2) set.add(pickFrom(PIXIVIC_TAGS.tier0));
      set.add(pickFrom(PIXIVIC_TAGS.tier1));
    } else {
      while (set.size < 3) set.add(pickFrom(PIXIVIC_TAGS.tier1));
    }
    set.add(pickFrom(PIXIVIC_TAGS.tier3));
    return [...set];
  }
  // 单独说「涩图」之外的词，也带一个近景 tag
  if (/涩|擦边|裸|胸|臀|腿|色/.test(q)) {
    return [q, PIXIVIC_TAGS.tier3[Math.floor(Math.random() * PIXIVIC_TAGS.tier3.length)]];
  }
  return [q];
}

async function pixivicCollect(keyword, { pages = 3, pageSize = 50, sort = 'popular', startPage = 1, perKeywordPages, r18Only = false } = {}) {
  const token = pixivicToken();
  if (!token) return { list: [], error: PIXIVIC_HINT };
  const ps = Math.max(10, Math.min(50, Number(pageSize) || 50));
  const np = Math.max(1, Math.min(6, Number(pages) || 3));
  const sp = Math.max(1, Number(startPage) || 1);

  // 支持一次传多个关键词（用 "A|B|C"），每个词各抓几页再合并
  const keywords = String(keyword).split('|').map((x) => x.trim()).filter(Boolean);
  const pp = Math.max(1, Math.min(4, Number(perKeywordPages) || (keywords.length > 1 ? 2 : np)));
  const paths = [];
  for (const kw of keywords) {
    for (let i = 0; i < (keywords.length > 1 ? pp : np); i += 1) {
      paths.push(`/illustrations?keyword=${encodeURIComponent(kw)}&page=${sp + i}&pageSize=${ps}`);
    }
  }
  const results = await Promise.all(paths.map((path) =>
    pixivicFetch(path, token).then((r) => r.json).catch(() => null)));

  const seen = new Set();
  const all = [];
  for (const json of results) {
    const arr = json?.data ?? json?.content ?? json?.list ?? json?.body ?? [];
    for (const raw of arr) {
      const item = normalizePixivicItem(raw);
      if (item.type && /ad/i.test(item.type)) continue;
      if (!item.id || !item.url) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
  }
  // 要 R18 就把池子收到 xrestrict>0；如果这个 tag 压根没有 R18，退回原池，别把结果清空
  const pool = r18Only && all.some((x) => Number(x.xrestrict) > 0)
    ? all.filter((x) => Number(x.xrestrict) > 0)
    : all;
  if (sort === 'popular') {
    pool.sort((a, b) => (Number(b.totalBookmarks) || 0) - (Number(a.totalBookmarks) || 0));
  }
  return { list: pool, pagesFetched: paths.length, startPage: sp, keywords };
}

async function pixivicSearch({ query, count = 5, page = 1, pageSize = 50, safeOnly = false, pages = 3, sort = 'popular', r18 = true } = {}) {
  const kw = String(query ?? '').trim();
  if (!kw) throw new Error('query 不能为空');
  const token = pixivicToken();
  if (!token) return PIXIVIC_HINT;

  const n = Math.max(1, Math.min(10, Number(count) || 5));
  const p = Math.max(1, Number(page) || 1);
  const tags = expandTagQuery(kw, r18);
  const joined = tags.join('|');
  const { list: all, pagesFetched } = await pixivicCollect(joined, { pages, pageSize, sort, startPage: p, r18Only: r18 });
  if (!all.length) return `pixivic 搜「${kw}」没有结果（抓了 ${pagesFetched} 页）。`;
  const tagNote = tags.length > 1 ? `｜组合 ${tags.join(' + ')}` : '';

  const list = safeOnly && all.some((x) => x.xrestrict === 0) ? all.filter((x) => x.xrestrict === 0) : all;
  const shown = list.slice(0, n);
  const tail = `（${shown.length}/${all.length} 件，${pagesFetched} 页${sort === 'popular' ? '，按收藏排序' : ''}${tagNote}）`;
  return `pixivic 搜索「${kw}」${tail}：\n` + shown.map(fmtPixivicLine).join('\n');
}

async function pixivicSend({ key, query, count = 3, safeOnly = false, pages = 3, sort = 'popular', asFile = true, r18 = true } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const kw = String(query ?? '').trim();
  if (!kw) throw new Error('query 不能为空');
  const token = pixivicToken();
  if (!token) return PIXIVIC_HINT;

  const n = Math.max(1, Math.min(5, Number(count) || 3));

  const gateMsg = imgGateCheck(key);
  if (gateMsg) return gateMsg;

  // 随机起始页 + 多页抓取：同一关键词每次拿到的池子不一样，不会老是那几张
  const tags = expandTagQuery(kw, r18);
  const startPage = 1 + Math.floor(Math.random() * 3);
  const { list: all, pagesFetched } = await pixivicCollect(tags.join('|'), { pages, pageSize: 50, sort, startPage, r18Only: r18 });
  if (!all.length) return `pixivic 搜「${kw}」没有可发的图（抓了 ${pagesFetched} 页）。`;

  const filtered = safeOnly && all.some((x) => x.xrestrict === 0)
    ? all.filter((x) => x.xrestrict === 0)
    : all;

  // 从「收藏数前 60%」里随机挑：既保证质量，又不是永远发同一张
  const poolSize = Math.max(n * 3, Math.min(filtered.length, Math.ceil(filtered.length * 0.85)));
  const qualityPool = filtered.slice(0, poolSize);
  const picks = qualityPool.slice().sort(() => Math.random() - 0.5).slice(0, n);

  const [, kind, target] = m;
  const picksIds = picks.map((x) => x.id);

  let sent = 0;
  const failed = [];
  for (const w of picks) {
    try {
      let buf = null;
      const chain = asFile
        ? [w.originalUrl, w.originalUrlAlt, w.sendUrl, w.url, w.sendUrlSmall]
        : [w.sendUrl, w.url, w.sendUrlSmall, w.originalUrlAlt];
      for (const u of chain.filter(Boolean)) {
        try {
          const isOrig = asFile && (u === w.originalUrl || u === w.originalUrlAlt);
          const b = await fetchImageBuffer(u, isOrig ? 75000 : (u === w.sendUrl ? 45000 : 25000));
          if (b && b.length >= 2000) { buf = b; break; }
        } catch { /* 试下一个尺寸 */ }
      }
      if (!buf) throw new Error('取图失败');
      if (asFile) {
        const { kind, target } = parseKey(key);
        const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
        const ext = isPng ? 'png' : 'jpg';
        await sendFileToChat({ kind, target, buffer: buf, name: `pixiv-${w.id}.${ext}` });
      } else {
        await sendImageTo(key, buf);
      }
      sent += 1;
    } catch (e) {
      failed.push(`${w.id}（${String(e?.message ?? e).slice(0, 40)}）`);
      // 换 yuki 兜底再试一次
      if (w.fallbackUrl) {
        try {
          const b2 = await fetchImageBuffer(w.fallbackUrl, 20000);
          if (b2 && b2.length > 2000) {
            await sendImageTo(key, b2);
            sent += 1;
            failed.pop();
          }
        } catch { /* 还是失败就记着 */ }
      }
    }
  }
  imgGateMark(key, sent);
  const tagNote = tags.length > 1 ? `｜组合 ${tags.join(' + ')}` : '';
  const tail = `（池子 ${all.length} 件／${pagesFetched} 页，起始第 ${startPage} 页${tagNote}）`;
  if (!sent) return `pixivic 找到 ${picks.length} 张但都没取下来（${failed.join('、')}）${tail}`;
  return `从 pixivic 发了 ${sent} 张到 ${key}（${picksIds.slice(0, sent).join('、')}）${tail}`;
}

async function siteSearch({ query, site, limit = 5 } = {}) {
  const q = clip(query, 60);
  if (!q) throw new Error('query 不能为空');
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const full = site ? `site:${String(site).replace(/^https?:\/\//, '').replace(/\/$/, '')} ${q}` : q;
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(full)}&setlang=zh-Hans`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    const snippet = stripTags(m[3]).replace(/\s+/g, ' ').trim().slice(0, 220);
    out.push({ url: m[1], title: stripTags(m[2]).trim(), snippet });
  }
  if (!out.length) return `没搜到「${full}」。`;
  return `Bing${site ? `（限 ${site}）` : ''} 搜「${q}」：\n` + out.map((x, i) =>
    `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`,
  ).join('\n');
}

// 抓网页 → 纯文本（去掉 script/style/标签），给模型读正文用
// Gemini修改：提取网页有效内容图片（解析相对路径为绝对 URL，过滤 icon/logo/小图）
function extractContentImages(html, baseUrl, maxImages = 10) {
  const results = [];
  const seen = new Set();
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    const getAttr = (name) => {
      const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const r = re.exec(attrs);
      return (r?.[1] ?? r?.[2] ?? r?.[3] ?? '').trim();
    };
    const rawSrc = getAttr('data-original') || getAttr('data-src') || getAttr('oldsrc') || getAttr('src');
    if (!rawSrc || /^data:|^blob:|^javascript:/i.test(rawSrc)) continue;
    let absUrl = '';
    try {
      absUrl = new URL(rawSrc, baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(absUrl) || seen.has(absUrl)) continue;
    if (/\.svg(\?|$)/i.test(absUrl)) continue;
    if (/(favicon|logo|icon|avatar|emoji|spacer|pixel|blank|1x1|qrcode|wx_fmt=gif|badge|banner_bg|btn_)/i.test(absUrl)) continue;
    const w = Number(getAttr('width') || 0);
    const h = Number(getAttr('height') || 0);
    if ((w > 0 && w < 80) || (h > 0 && h < 80)) continue;

    let alt = getAttr('alt') || getAttr('title');
    if (!alt) {
      const after = html.slice(m.index + m[0].length, m.index + m[0].length + 220);
      const cap = after.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (cap && cap.length <= 80) alt = cap;
    }
    seen.add(absUrl);
    results.push({ url: absUrl, alt: alt.replace(/\s+/g, ' ').trim().slice(0, 80) });
    if (results.length >= maxImages) break;
  }
  return results;
}

async function pageText({ url, maxChars = 6000 } = {}) {
  let target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('url 要是 http(s) 开头');
  // B站专栏是前端渲染，自动改走 read/mobile（服务端渲染）
  const cv = biliArticleId(target);
  if (cv) {
    try { return await biliArticle({ id: cv, maxChars: maxChars }); } catch { /* 保底走原逻辑 */ }
  }
  const limit = Math.max(500, Math.min(20000, Number(maxChars) || 6000));
  const res = await fetch(target, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: new URL(target).origin + '/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`);
  let html = await res.text();
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const finalUrl = res.url || target;
  const imgs = extractContentImages(html, finalUrl, 10);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  let text = stripTags(html)
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return `页面没抓到正文（可能是前端渲染）：${target}`;
  const imgBlock = imgs.length
    ? `\n\n【网页内嵌统计图表与图片列表】\n${imgs.map((im, i) => `${i + 1}. ${im.alt ? `[${im.alt}] ` : ''}${im.url}`).join('\n')}`
    : '';
  return `【${title || target}】${finalUrl}\n${text.slice(0, limit)}${text.length > limit ? `\n…[截断，原长 ${text.length}]` : ''}${imgBlock}`;
}


// B站站内搜索（专栏/视频）——中文攻略、台词整理基本都在这里，比 Bing 好使
async function biliSearch({ query, kind = 'article', limit = 5 } = {}) {
  const q = clip(query, 40);
  if (!q) throw new Error('query 不能为空');
  const k = kind === 'video' ? 'video' : 'article';
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const d = await biliGet(`https://api.bilibili.com/x/web-interface/search/type?search_type=${k}&keyword=${encodeURIComponent(q)}&page=1`);
  const items = (d?.data?.result ?? []).map((x) => {
    const title = stripTags(String(x?.title ?? '')).replace(/&quot;/g, '"');
    if (k === 'video') {
      return { title, url: `https://www.bilibili.com/video/${x?.bvid}`, meta: `${x?.author ?? ''}｜${x?.play ?? 0}播放` };
    }
    return { title, url: `https://www.bilibili.com/read/cv${x?.id}`, meta: `${x?.author_name ?? x?.author ?? ''}｜${x?.view ?? 0}阅读` };
  }).filter((x) => x.url && !x.url.endsWith('undefined'));
  if (!items.length) return `B站没搜到「${q}」（${k}）。`;
  return `B站${k === 'video' ? '视频' : '专栏'}搜「${q}」：\n` + items.slice(0, n).map((x, i) =>
    `${i + 1}. ${clip(x.title, 50)}\n   ${x.url}\n   ${x.meta}`,
  ).join('\n') + `\n（读正文用 page_text；视频可让用户自己点开）`;
}

// 多引擎搜索：bing / 360 / sogou 原生可用；google 走代理（若配了），yandex / baidu 受限时返回原因
const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHtml(url, extraHeaders = {}, timeout = 20000) {
  const res = await fetch(url, {
    headers: {
      'user-agent': SEARCH_UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extraHeaders,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  return { status: res.status, html: await res.text() };
}

// Bing：<h2><a href="…">标题</a>，摘要取紧随其后的 <p> / b_caption
function parseBing(html, limit) {
  const out = [];
  const re = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,800}?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const url = m[1];
    if (!/^https?:/i.test(url) || /bing\.com/i.test(url)) continue;
    out.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3] ?? '').slice(0, 220) });
  }
  return out;
}

// 360：<li class="res-list"> … <h3 class="res-title"><a href="…">标题</a> … <p class="res-desc">
function parse360(html, limit) {
  const out = [];
  const blocks = html.split(/<li[^>]*class="[^"]*res-list[^"]*"/).slice(1);
  for (const b of blocks) {
    if (out.length >= limit) break;
    const a = /<h3[^>]*class="[^"]*res-title[^"]*"[^>]*>[\s\S]{0,200}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b)
      ?? /<h3[^>]*>[\s\S]{0,200}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const desc = /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(b)
      ?? /<div[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    let href = a[1].startsWith('//') ? `https:${a[1]}` : a[1];
    const title = htmlToText(a[2]);
    // 跳过站内推荐/相关搜索这类假结果
    if (!/^https?:/i.test(href)) continue;
    if (/so\.com\/s\?|ai\.so\.com|related_middle/i.test(href)) continue;
    if (/其他人还搜|相关搜索|反馈/.test(title)) continue;
    out.push({ title, url: href, snippet: htmlToText(desc?.[1] ?? '').slice(0, 220) });
  }
  return out;
}

// 搜狗：<div class="vrwrap"> … <h3 class="vr-title"><a href="/link?url=…">标题</a>
function parseSogou(html, limit) {
  const out = [];
  const blocks = html.split(/<div[^>]*class="[^"]*vrwrap[^"]*"/).slice(1);
  for (const b of blocks) {
    if (out.length >= limit) break;
    const a = /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>[\s\S]{0,300}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b)
      ?? /<h3[^>]*>[\s\S]{0,300}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const href = a[1];
    const desc = /<div[^>]*class="[^"]*(?:fz-mid|text-layout|space-txt|str-info)[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    out.push({
      title: htmlToText(a[2]),
      url: href.startsWith('/') ? `https://www.sogou.com${href}` : href,
      snippet: htmlToText(desc?.[1] ?? '').slice(0, 220),
    });
  }
  return out;
}

// Google 只有走代理才通：<a href="/url?q=…"> 或 <div class="yuRUbf"><a href="…">
function parseGoogle(html, limit) {
  const out = [];
  const re = /<a[^>]*href="(\/url\?q=[^"]+|https?:\/\/[^"]+)"[^>]*>[\s\S]{0,400}?<h3[^>]*>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let url = m[1];
    if (url.startsWith('/url?q=')) {
      url = decodeURIComponent(url.slice(7).split('&')[0]);
    }
    if (!/^https?:/i.test(url) || /google\./i.test(url)) continue;
    out.push({ title: htmlToText(m[2]), url, snippet: '' });
  }
  return out;
}

const SEARCH_ENGINES = {
  bing: { host: 'https://cn.bing.com', path: (q) => `/search?q=${encodeURIComponent(q)}&setlang=zh-Hans`, parse: parseBing },
  '360': { host: 'https://www.so.com', path: (q) => `/s?q=${encodeURIComponent(q)}`, parse: parse360, referer: 'https://www.so.com/' },
  sogou: { host: 'https://www.sogou.com', path: (q) => `/web?query=${encodeURIComponent(q)}`, parse: parseSogou, referer: 'https://www.sogou.com/' },
  google: { host: 'https://www.google.com', path: (q) => `/search?q=${encodeURIComponent(q)}&hl=zh-CN`, parse: parseGoogle, needsProxy: true },
};

function fmtSearchResults(engine, query, items) {
  return `${engine} 搜「${query}」（${items.length} 条）：\n` + items.map((x, i) =>
    `${i + 1}. ${x.title || '(无标题)'}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`,
  ).join('\n');
}

async function searchOne(engine, query, limit) {
  const conf = SEARCH_ENGINES[engine];
  if (!conf) throw new Error(`不认识引擎「${engine}」`);
  const url = conf.host + conf.path(query);
  if (conf.needsProxy) {
    // Google 只能走隧道代理
    const res = await proxyFetch(url, {
      dispatcher: pixivDispatcher(),
      headers: { 'user-agent': SEARCH_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return conf.parse(await res.text(), limit);
  }
  const { status, html } = await fetchHtml(url, conf.referer ? { referer: conf.referer } : {});
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = conf.parse(html, limit);
  if (!items.length) {
    if (/安全验证|验证码|captcha|smartcaptcha/i.test(html)) throw new Error('被反爬拦截（验证码页）');
    throw new Error('页面解析不到结果（可能改版）');
  }
  return items;
}

// 搜狗结果是 /link?url=… 跳转，尽量还原成真实地址（失败就保留跳转链）
async function resolveRedirect(url) {
  if (!/(sogou\.com\/link\?|so\.com\/link\?)/i.test(url)) return url;
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'manual',
      headers: { 'user-agent': SEARCH_UA, referer: 'https://www.sogou.com/' },
      signal: AbortSignal.timeout(5000),
    });
    const loc = res.headers.get('location');
    if (loc && /^https?:/i.test(loc)) return loc;
    // 360 的 /link 返回 200 + JS 跳转，从 body 里抠真实地址
    if (res.status === 200) {
      const body = await res.text().catch(() => '');
      const m = /location\.replace\(["']([^"']+)["']\)/.exec(body)
        ?? /http-equiv="refresh"[^>]*URL='?([^"'>]+)'?/i.exec(body);
      if (m && /^https?:/i.test(m[1])) return m[1];
    }
  } catch { /* 保留原链 */ }
  return url;
}

// ── 免 key 搜索引擎：Exa MCP（主） / Tavily keyless（备） ────────────────
// 服务器实测（116.62.208.153）：Exa 25/25 无失败、均 2.1s；Tavily 第 22 次触发
// hourly_cap_reached（约 21 次/小时/IP）。所以 Exa 打头，Tavily 当备用且限额。
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
// 可选：search-keys.json 里写 {"exa":"xxx"} 就用带 key 的 MCP（免 key 档约 30 次就限流）
const SEARCH_KEYS = `${ROOT}/search-keys.json`;
function searchKey(name) {
  try { return String(JSON.parse(readFileSync(SEARCH_KEYS, 'utf8'))[name] ?? '').trim(); } catch { return ''; }
}
function exaEndpoint() {
  const k = searchKey('exa');
  return k ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(k)}` : EXA_MCP_URL;
}
const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_HOURLY_CAP = 18;
let tavilyWindow = { hour: -1, used: 0 };
let exaRateLimitedUntil = 0;

function tavilyBudgetOk() {
  const h = Math.floor(Date.now() / 3600000);
  if (tavilyWindow.hour !== h) tavilyWindow = { hour: h, used: 0 };
  if (tavilyWindow.used >= TAVILY_HOURLY_CAP) return false;
  tavilyWindow.used += 1;
  return true;
}

function parseExaSSE(raw) {
  const texts = [];
  for (const line of String(raw).split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const j = JSON.parse(line.slice(5).trim());
      // 免费 MCP 限流时 HTTP 仍是 200，只在 _meta 里标记 —— 不识别就会当成「没结果」静默降级
      if (j?.result?._meta?.['ai.exa/rateLimited']) {
        exaRateLimitedUntil = Date.now() + 30 * 60 * 1000;
        throw new Error('Exa 免费额度已用尽（30 分钟内跳过）');
      }
      for (const c of j?.result?.content ?? []) if (c?.text) texts.push(String(c.text));
    } catch (error) {
      if (String(error?.message ?? '').includes('Exa 免费额度')) throw error;
      /* 跳过非 JSON 帧 */
    }
  }
  const blocks = texts.join('\n').split(/\n(?=Title: )/);
  const items = [];
  for (const b of blocks) {
    const url = (/^URL:\s*(\S+)/m.exec(b) ?? [])[1];
    if (!url) continue;
    const title = ((/^Title:\s*(.+)$/m.exec(b) ?? [])[1] ?? url).trim();
    const published = ((/^Published:\s*(\S+)/m.exec(b) ?? [])[1] ?? '').trim();
    const hi = ((/Highlights?:\s*\n([\s\S]*)/.exec(b) ?? [])[1] ?? '').replace(/\s+/g, ' ').trim();
    items.push({ title, url, snippet: hi.slice(0, 220), published: /^\d{4}-\d{2}-\d{2}/.test(published) ? published : '' });
  }
  return items;
}

async function exaSearch(q, n) {
  if (!searchKey('exa') && Date.now() < exaRateLimitedUntil) throw new Error('Exa 冷却中（免费额度已用尽）');
  const res = await fetch(exaEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query: q, numResults: n } } }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
  return parseExaSSE(await res.text()).slice(0, n);
}

async function tavilySearch(q, n) {
  if (!tavilyBudgetOk()) throw new Error('Tavily 本小时额度已用完');
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json',
      'x-tavily-access-mode': 'keyless', 'user-agent': UA },
    body: JSON.stringify({ query: q, max_results: n, search_depth: 'basic' }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429) throw new Error('Tavily 限流（hourly_cap_reached）');
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const j = await res.json();
  return (j?.results ?? []).filter((r) => r?.url).map((r) => ({
    title: String(r.title ?? r.url), url: String(r.url),
    snippet: String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 220), published: String(r.published_date ?? ''),
  })).slice(0, n);
}

async function webSearch({ query, engine = 'auto', limit = 6 } = {}) {
  const q = clip(query, 80);
  if (!q) throw new Error('query 不能为空');
  const n = Math.max(1, Math.min(10, Number(limit) || 6));
  const order = engine === 'auto'
    ? ['exa', 'tavily', '360', 'sogou', 'bing']
    : [String(engine).toLowerCase()];

  const tried = [];
  for (const e of order) {
    try {
      let items;
      if (e === 'exa') items = await exaSearch(q, n);
      else if (e === 'tavily') items = await tavilySearch(q, n);
      else items = await searchOne(e, q, n);
      if (items.length) {
        const tail = tried.length ? `\n（${tried.join('；')}）` : '';
        if (e === 'sogou' || e === '360') {
          for (const it of items) it.url = await resolveRedirect(it.url);
        }
        return fmtSearchResults(e, q, items) + tail;
      }
    } catch (error) {
      tried.push(`${e} 失败：${error?.message ?? error}`);
    }
  }
  // 全部失败时，把原因摊开，别让模型以为「没结果」
  return `搜索没成功。\n${tried.join('\n')}\nyandex / baidu 从这台服务器被反爬拦住（smart captcha / 百度安全验证），google 需要代理。`;
}


// ── lolicon 随机图（api.lolicon.app/setu/v2，免 key）─────────────────
const LOLICON_API = 'https://api.lolicon.app/setu/v2';

async function loliconFetch({ tags = [], count = 1, size = 'regular', r18 = 'only', keyword = '', excludeAI = false, aspectRatio = '', uid = '' } = {}) {
  const r18v = r18 === 'mixed' ? '2' : r18 === 'none' ? '0' : '1';
  const params = new URLSearchParams({ num: String(Math.min(10, Math.max(1, count))), r18: r18v, size });
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[\s,，]+/).filter(Boolean);
  for (const t of list.slice(0, 3)) params.append('tag', t);
  if (keyword) params.set('keyword', String(keyword).slice(0, 40));
  if (excludeAI) params.set('excludeAI', 'true');
  if (aspectRatio) params.set('aspectRatio', String(aspectRatio));
  if (uid) params.set('uid', String(uid).replace(/\D/g, ''));
  const res = await fetch(`${LOLICON_API}?${params}`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (j?.error) throw new Error(`lolicon: ${j.error}`);
  return (j?.data ?? []).filter((x) => x?.urls && (x.urls.small || x.urls.regular || x.urls.original));
}

// ── 发图冷却 ──────────────────────────────────────────────────
// 一次请求只该发一轮图。模型有时会因为下载慢而重复调用同一个工具，
// 结果同一句话要图变成连发好几轮。这里按会话做 90 秒冷却，拦住重复调用。
const IMG_COOLDOWN_MS = 0;        // 冷却已按要求关闭
const IMG_ATTEMPT_MS = 0;         // 冷却已按要求关闭
const lastImgSendAt = new Map();
const lastImgAttemptAt = new Map();

function imgCooldownLeft(key) {
  const k = String(key);
  const sent = lastImgSendAt.get(k) || 0;
  const tried = lastImgAttemptAt.get(k) || 0;
  const left = Math.max(IMG_COOLDOWN_MS - (Date.now() - sent), IMG_ATTEMPT_MS - (Date.now() - tried));
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function markImgAttempt(key) {
  lastImgAttemptAt.set(String(key), Date.now());
}

function markImgSent(key) {
  lastImgSendAt.set(String(key), Date.now());
}

// ── 全局发图闸门 ────────────────────────────────────────────────
// 随机图 / pixivic / 搜图 / 图库 四个工具共用一份计数：
//   · 同一个会话 120 秒内只放一次发图调用（不管哪个工具）
//   · 每小时最多 12 张
// 这是拦「模型自己循环调工具」的最后一道闸，和单个工具的冷却无关。
const IMG_GATE_GAP_MS = 0;   // 不限制间隔
const IMG_GATE_HOUR_MAX = 999;  // 只留一个防跑飞的兜底
const imgGate = new Map();   // key -> { lastAt, hourStart, hourCount }

function imgGateCheck(key) {
  const k = String(key);
  const now = Date.now();
  let g = imgGate.get(k);
  if (!g) { g = { lastAt: 0, hourStart: now, hourCount: 0 }; imgGate.set(k, g); }
  if (now - g.hourStart > 3600000) { g.hourStart = now; g.hourCount = 0; }
  const gapLeft = Math.ceil((IMG_GATE_GAP_MS - (now - g.lastAt)) / 1000);
  if (gapLeft > 0) {
    return `刚发过图了（还要 ${gapLeft} 秒才允许再发）。对方明确说「再来一张」「换一张」才继续，否则停。`;
  }
  if (g.hourCount >= IMG_GATE_HOUR_MAX) {
    return `这一小时已经发了 ${g.hourCount} 张，先歇会儿。`;
  }
  // 检查通过就立刻占位：两个发图工具并发时，第二个会被这道闸挡住
  g.lastAt = now;
  g.hourCount += 1;
  return null;
}

function imgGateMark(key, count = 1) {
  // 占位时已记 1 张，这里只把超出的部分补上
  const extra = Math.max(0, (Number(count) || 1) - 1);
  if (!extra) return;
  const k = String(key);
  const g = imgGate.get(k);
  if (g) g.hourCount += extra;
}

// 不传 tag 时自动抽一个露骨 tag，别让「随机」掉到擦边档
const LOLI_R18_TAGS = ['中出し', 'おっぱい', 'フェラ', 'パイズリ', '全裸', '潮吹き', '断面図', '巨乳', '騎乗位', '正常位'];
function pickLoliTag() { return LOLI_R18_TAGS[Math.floor(Math.random() * LOLI_R18_TAGS.length)]; }

async function randomImage({ key, tags, count = 1, size = 'regular', asFile = false, r18 = 'only', keyword = '', excludeAI = false, aspectRatio = '', uid = '' } = {}) {
  const hasTags = (Array.isArray(tags) && tags.length > 0) || (typeof tags === 'string' && tags.trim() !== '');
  const useTags = hasTags ? tags : (r18 === 'none' || keyword ? [] : [pickLoliTag()]);
  const opt = { tags: useTags, count, size, r18, keyword, excludeAI, aspectRatio, uid };
  if (!key) {
    const items = await loliconFetch(opt);
    if (!items.length) return '这次没抽到，换个 tag 再试试。';
    return items.map((x, i) => `${i + 1}. ${clip(x.title || '(无题)', 40)} — ${x.author}｜${(x.tags || []).slice(0, 4).join('、')}\n   ${x.urls[size] || x.urls.regular || x.urls.small || x.urls.original}`).join('\n');
  }

  const gateMsg = imgGateCheck(key);
  if (gateMsg) return gateMsg;
  const left = imgCooldownLeft(key);
  if (left) {
    return `刚刚发过一轮了（还剩 ${left} 秒冷却），先不重复发。对方明确再要才发下一轮。`;
  }
  markImgAttempt(key);

  // 要原图就必须让接口返回 original，否则 urls 里根本没有这个字段
  const wantOriginal = asFile || size === 'original';
  const items = await loliconFetch({ ...opt, size: wantOriginal ? 'original' : size });
  if (!items.length) return '这次没抽到，换个 tag 再试试。';
  let sent = 0;
  for (const it of items) {
    const url = it.urls[size] || it.urls.regular || it.urls.small || it.urls.original;
    // 高清优先：先拉 regular（约 600~900KB），失败再退 small（约 20KB）
    let buf = null;
    const chain = wantOriginal
      ? [[it.urls.original, 120000], [it.urls.large || it.urls.regular, 60000], [it.urls.small, 25000]]
      : [[url, 60000], [it.urls.small, 25000]];
    for (const [attempt, ms] of chain) {
      if (!attempt) continue;
      try {
        const res = await fetch(attempt, { headers: { 'user-agent': UA, referer: 'https://www.pixiv.net/' },
          signal: AbortSignal.timeout(ms) });
        if (!res.ok) continue;
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length >= 2000) { buf = b; break; }
      } catch { /* 换下一个尺寸 */ }
    }
    if (!buf) continue;
    if (asFile) {
      // 收藏级：按文件发，QQ 不压缩，对方点开就是原图
      const { kind, target } = parseKey(key);
      const usedUrl = chain.map(([u]) => u).find((u) => u && buf) || '';
      const ext = /\.png/i.test(usedUrl || it.urls.original || '') ? 'png' : 'jpg';
      await sendFileToChat({ kind, target, buffer: buf, name: `pixiv-${it.pid || Date.now()}.${ext}` });
    } else {
      await sendImageTo(key, buf);
    }
    sent += 1;
  }
  if (!sent) return '图下载失败，稍后再试。';
  markImgSent(key);
  imgGateMark(key, sent);
  return `发了 ${sent} 张随机图到 ${key}（pixiv id ${items.slice(0, sent).map((x) => x.pid).join(', ')}）。已经发完，本轮不要再调这个工具。`;
}

// ── 服务器状况（只读，给 agent 答“服务器现在怎么样”）───────────────
function readProc(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function shOut(cmd, timeout = 8000) {
  try {
    return execSync(cmd, { timeout, encoding: 'utf8', windowsHide: true }).trim();
  } catch { return ''; }
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d ? `${d} 天` : '', h ? `${h} 小时` : '', `${m} 分`].filter(Boolean).join(' ');
}

async function serverStatus({ detail = false } = {}) {
  const mem = readProc('/proc/meminfo');
  const pick = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(mem);
    return m ? Number(m[1]) / 1024 : 0;      // MB
  };
  const total = pick('MemTotal');
  const avail = pick('MemAvailable');
  const used = Math.max(0, total - avail);
  const swapTotal = pick('SwapTotal');
  const swapFree = pick('SwapFree');

  const load = readProc('/proc/loadavg').trim().split(/\s+/).slice(0, 3).join(' / ');
  const cores = os.cpus().length;
  const up = fmtUptime(os.uptime());

  // df -h 输出：Filesystem Size Used Avail Use% Mounted-on（挂载点可能带空格，取第 5 个字段之后）
  const disk = shOut('df -h / /opt 2>/dev/null')
    .split('\n').slice(1).filter(Boolean)
    .map((l) => {
      const p2 = l.trim().split(/\s+/);
      if (p2.length < 6) return '';
      return `${p2.slice(5).join(' ')} ${p2[2]}/${p2[1]}（${p2[4]}）`;
    })
    .filter(Boolean)
    .join('、');

  const services = [
    ['dsh-server', 'AI 服务'],
    ['qq-bridge', 'QQ 桥接'],
    ['vpn', '代理内核'],
    ['bili-poll.timer', 'B站轮询'],
    ['memory-consolidate.timer', '记忆沉淀'],
    ['qzone-diary.timer', '日记定时'],
  ].map(([unit, label]) => `${label}${shOut(`systemctl is-active ${unit}`) === 'active' ? '✓' : '✗'}`).join(' ');

  const snow = shOut("docker inspect -f '{{.State.Status}}' snowluma 2>/dev/null") || '未运行';
  const procs = shOut('ps -e --no-headers 2>/dev/null | wc -l');

  let text = `主机 ${os.hostname()}｜${os.platform()} ${os.release()}｜${cores} 核
运行 ${up}｜负载 ${load}
内存 ${(used / 1024).toFixed(1)}/${(total / 1024).toFixed(1)}GB 使用（可用 ${(avail / 1024).toFixed(1)}GB）`
    + (swapTotal > 0 ? `｜交换 ${((swapTotal - swapFree) / 1024).toFixed(1)}/${(swapTotal / 1024).toFixed(1)}GB` : '')
    + `
磁盘 ${disk}
服务 ${services}｜QQ 容器 ${snow}｜进程 ${procs} 个`;

  // 外部凭据到期提醒（pixivic 图源 / 出图额度）
  const warns = [];
  try {
    const conf = JSON.parse(readFileSync(`${ROOT}/pixivic.json`, 'utf8'));
    const info = pixivicTokenInfo(conf.token);
    if (!info) warns.push('pixivic token 读不出来，图源可能不可用');
    else if (info.hoursLeft <= 0) warns.push(`pixivic token 已过期 ${Math.abs(info.hoursLeft).toFixed(0)} 小时，擦边图走不了，要重新获取`);
    else if (info.hoursLeft < 24) warns.push(`pixivic token 还剩 ${info.hoursLeft.toFixed(0)} 小时到期，记得换`);
  } catch { /* 没配就是没配，不刷屏 */ }
  try {
    const q = JSON.parse(readFileSync(`${ROOT}/imagegen-quota.json`, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    if (q?.date === today && Number(q.count) > 0) warns.push(`今日出图 ${q.count} 张`);
  } catch { /* 忽略 */ }
  if (warns.length) text += '\n提醒：' + warns.join('｜');

  if (detail) {
    const top = shOut("ps -eo comm,rss --sort=-rss --no-headers 2>/dev/null | head -5 | awk '{printf \"%s %.0fMB \", $1, $2/1024}'");
    text += `\n占用最高 ${top}`;
    const net = shOut("ss -lnt 2>/dev/null | awk 'NR>1{print $4}' | sed 's/.*://' | sort -n | uniq | tr '\\n' ' '");
    text += `\n监听端口 ${net}`;
  }
  return text;
}

// ── 歌词 / 歌单（netease-music-mcp 的能力，接到 QQ 里用）──────────────
const PLAYLIST_DB = `${ROOT}/playlists.sqlite`;

function lyricClean(lrc) {
  // 去掉时间轴标记，保留句子
  return String(lrc || '')
    .split('\n')
    .map((x) => x.replace(/\[[^\]]*\]/g, '').trim())
    .filter((x) => x && !/^作词|^作曲|^编曲|^制作|^混音/.test(x))
    .join('\n');
}

async function neteaseLyric(id) {
  const d = await getJSON(
    `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`,
    { headers: { referer: 'https://music.163.com/' } },
  );
  return {
    lrc: lyricClean(d?.lrc?.lyric ?? ''),
    translation: lyricClean(d?.tlyric?.lyric ?? ''),
  };
}


// 搜歌结果收敛：先按「查询里的歌手名」过滤，再压翻唱/伴奏/切片。
// 例：搜「晴天 周杰伦」，artist 不含「周杰伦」的全丢掉——宁可只剩一条，也不给翻唱。
function pickCandidates(list, query) {
  const raw = Array.isArray(list) ? [...list] : [];
  const q = String(query ?? '').trim();
  if (!raw.length) return raw;

  // 从查询里猜歌手名：去掉歌名后剩下的那段，或整体（有人只写歌手）
  const tokens = q.split(/[\s\-—/／|、,，]+/).filter((x) => x.length >= 1);
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s·・.]/g, '');

  const matchArtist = (item) => {
    const a = norm(item.artist);
    if (!a) return false;
    // 全串包含（「周杰伦」in「周杰伦 / 杨瑞代」）
    if (tokens.some((tk) => tk.length >= 2 && a.includes(norm(tk)))) return true;
    // 有英文名时也认（Jay Chou）
    if (tokens.some((tk) => tk.length >= 2 && norm(item.name).includes(norm(tk)))) return true;
    return false;
  };

  const penalty = (s) => {
    const blob = `${s.name} ${s.artist}`;
    if (/翻唱|cover|伴奏|remix|抖音|片段|铃声|remake|翻自|纯音乐/i.test(blob)) return 2;
    if (/原唱|live|演唱会|翻唱版/i.test(blob)) return 1;
    return 0;
  };

  const scored = raw.map((item, i) => ({ item, hits: matchArtist(item) ? 0 : 1, pen: penalty(item), i }));
  scored.sort((a, b) => a.hits - b.hits || a.pen - b.pen || a.i - b.i);

  const hitCount = scored.filter((s) => s.hits === 0).length;
  // 至少得有一首歌手对得上，否则（可能只给了歌名）退回全部，只做翻唱降权
  const kept = hitCount > 0 ? scored.filter((s) => s.hits === 0) : scored;
  return kept.map((s) => s.item);
}

async function songLyrics({ id, query, index = 1, maxChars = 3000 } = {}) {
  const limit = Math.max(300, Math.min(8000, Number(maxChars) || 3000));
  const songId = String(id ?? '').trim();

  // 有 id 就直接查；没有就搜，搜到多首时逐首试，取第一首有歌词的
  const candidates = [];
  if (songId) {
    let meta = null;
    try { meta = await neteaseDetail(songId); } catch { /* 没详情也行 */ }
    candidates.push({ id: songId, name: meta?.name, artist: meta?.artist });
  } else {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('给 id 或 query');
    const list = pickCandidates(await neteaseSearch(q, 10), q);
    if (!list.length) throw new Error(`网易云没搜到「${q}」`);
    const startIdx = Math.max(0, Math.min(list.length - 1, Number(index) - 1));
    const ordered = [list[startIdx], ...list.filter((_, i) => i !== startIdx)];
    for (const s of ordered.slice(0, 5)) candidates.push(s);
  }

  for (const c of candidates) {
    const { lrc, translation } = await neteaseLyric(c.id);
    if (!lrc) continue;
    const head = `《${c.name ?? c.id}》${c.artist ? ' — ' + c.artist : ''}`;
    let text = lrc.slice(0, limit);
    if (translation) {
      const lines = text.split('\n');
      const tl = translation.split('\n');
      text = lines.map((l, i) => (tl[i] && tl[i] !== l ? `${l}\n  ${tl[i]}` : l)).join('\n').slice(0, limit);
    }
    return `${head}\n${text}${lrc.length > limit ? '\n（已截断）' : ''}`;
  }
  return `《${candidates[0]?.name ?? songId ?? query}》没有歌词（纯音乐或版权受限）。`;
}

// 歌单：用 SQLite（node:sqlite 在 Node 24 内置）
let DatabaseSyncRef = null;
async function getDatabaseSync() {
  if (!DatabaseSyncRef) {
    try {
      const m = await import('node:sqlite');
      DatabaseSyncRef = m.DatabaseSync;
    } catch (e) {
      throw new Error('当前 Node 不支持 node:sqlite：' + String(e?.message ?? e).slice(0, 80));
    }
  }
  return DatabaseSyncRef;
}

function withDb(Sync, fn) {
  let db;
  try {
    db = new Sync(PLAYLIST_DB);
  } catch (e) {
    throw new Error('打开歌单库失败：' + String(e?.message ?? e).slice(0, 80));
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    db.exec(`CREATE TABLE IF NOT EXISTS playlist_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER NOT NULL,
      song_id TEXT NOT NULL, song_name TEXT NOT NULL, artist TEXT,
      note TEXT, play_count INTEGER DEFAULT 0,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    return fn(db);
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }
}

async function playlistTool({ action = 'list', playlist, query, index = 1, note, songId, name } = {}) {
  const act = String(action).toLowerCase();

  // 先把网络请求做完（withDb 的回调是同步的，不能在里面 await）
  let resolved = null;
  if (act === 'add') {
    let sid = String(songId ?? '').trim();
    if (!sid) {
      const q = String(query ?? '').trim();
      if (!q) throw new Error('给 songId 或 query');
      const list = pickCandidates(await neteaseSearch(q, 10), q);
      const pick = list[Math.max(0, Math.min(list.length - 1, Number(index) - 1))];
      if (!pick) throw new Error(`网易云没搜到「${q}」`);
      resolved = { id: pick.id, name: pick.name, artist: pick.artist };
    } else {
      try {
        const d = await neteaseDetail(sid);
        resolved = { id: sid, name: d.name, artist: d.artist };
      } catch {
        resolved = { id: sid, name: sid, artist: '' };
      }
    }
  }

  const Sync = await getDatabaseSync();
  return withDb(Sync, (db) => {
    const ensure = (pname) => {
      const found = db.prepare('SELECT id FROM playlists WHERE name = ?').get(pname);
      if (found) return found.id;
      const r = db.prepare('INSERT INTO playlists (name) VALUES (?)').run(pname);
      return Number(r.lastInsertRowid);
    };

    if (act === 'list') {
      const lists = db.prepare(`SELECT p.id, p.name, COUNT(s.id) AS n
        FROM playlists p LEFT JOIN playlist_songs s ON s.playlist_id = p.id
        GROUP BY p.id ORDER BY p.id`).all();
      if (!lists.length) return '还没有歌单。想建就说「建个歌单叫 xxx」。';
      const lines = [`共 ${lists.length} 个歌单：`];
      for (const l of lists) {
        lines.push(`· ${l.name}（${l.n} 首）`);
        const songs = db.prepare(`SELECT song_name, artist, play_count FROM playlist_songs
          WHERE playlist_id = ? ORDER BY id DESC LIMIT 8`).all(l.id);
        for (const s of songs) {
          lines.push(`    ${s.song_name}${s.artist ? ' — ' + s.artist : ''}` +
            (s.play_count ? ` ｜听 ${s.play_count} 次` : ''));
        }
        if (l.n > 8) lines.push(`    …还有 ${l.n - 8} 首`);
      }
      return lines.join('\n');
    }

    if (act === 'create') {
      const pname = String(name || playlist || '').trim();
      if (!pname) throw new Error('歌单要有名字');
      ensure(pname);
      return `建好了：${pname}`;
    }

    if (act === 'add') {
      const pname = String(playlist || '默认').trim();
      const pid = ensure(pname);
      const sid = resolved.id;
      const sname = resolved.name;
      const artist = resolved.artist;
      const dup = db.prepare('SELECT id FROM playlist_songs WHERE playlist_id = ? AND song_id = ?')
        .get(pid, sid);
      if (dup) return `《${sname}》已经在「${pname}」里了。`;
      db.prepare(`INSERT INTO playlist_songs (playlist_id, song_id, song_name, artist, note)
        VALUES (?, ?, ?, ?, ?)`).run(pid, sid, sname, artist, note ?? null);
      const n = db.prepare('SELECT COUNT(*) AS n FROM playlist_songs WHERE playlist_id = ?').get(pid).n;
      return `《${sname}》${artist ? ' — ' + artist : ''} 加进「${pname}」了，现在 ${n} 首。`;
    }

    if (act === 'remove') {
      const pname = String(playlist || '默认').trim();
      const pid = db.prepare('SELECT id FROM playlists WHERE name = ?').get(pname)?.id;
      if (!pid) throw new Error(`没有「${pname}」这个歌单`);
      const kw = String(query ?? '').trim();
      if (!kw) throw new Error('要说删哪首（query 关键词）');
      const rows = db.prepare(`SELECT id, song_name FROM playlist_songs
        WHERE playlist_id = ? AND song_name LIKE ?`).all(pid, `%${kw}%`);
      if (!rows.length) return `「${pname}」里没有匹配「${kw}」的歌。`;
      for (const r of rows) db.prepare('DELETE FROM playlist_songs WHERE id = ?').run(r.id);
      return `从「${pname}」删掉了：${rows.map((r) => r.song_name).join('、')}`;
    }

    throw new Error('action 只能是 list / create / add / remove');
  });
}

// ── 读音视频 / MIDI ────────────────────────────────────
const MEDIA_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus', '.aiff', '.amr',
  '.mp4', '.avi', '.rm', '.rmvb', '.mkv', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.3gp',
  '.mid', '.midi'];

function runMediaRead(filePath, maxSeconds) {
  const args = [`${ROOT}/media_read.py`, filePath, '--max-seconds', String(maxSeconds)];
  return new Promise((resolve, reject) => {
    execFile(PY, args, { timeout: 900000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) reject(new Error(String(stderr || error.message).slice(0, 300)));
      else resolve(String(stdout || stderr).trim());
    });
  });
}
async function mediaRead({ url, path: localPath, maxSeconds = 1800 } = {}) {
  const srcUrl = String(url ?? '').trim();
  const srcPath = String(localPath ?? '').trim();
  if (!srcUrl && !srcPath) throw new Error('给 url（文件地址）或 path（服务器路径）');

  if (srcPath) {
    if (!existsSync(srcPath)) throw new Error(`本地路径不存在：${srcPath}`);
    return await runMediaRead(srcPath, Math.max(10, Math.min(3600, Number(maxSeconds) || 1800)));
  }

  const name = decodeURIComponent((srcUrl.split('?')[0].split('/').pop() || 'file'));
  const ext = docExt(name);
  if (!MEDIA_EXTS.includes(ext)) throw new Error(`不支持的格式「${ext}」，支持 ${MEDIA_EXTS.join(' ')}`);
  const res = await fetch(srcUrl, {
    headers: { 'user-agent': UA, ...(srcUrl.includes('qq.com') ? { referer: 'https://qun.qq.com/' } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > DOC_MAX_BYTES) throw new Error(`文件太大（${Math.round(buf.length / 1048576)}MB，上限 60MB）`);
  mkdirSync(DOC_DIR, { recursive: true });
  const tmp = join(DOC_DIR, `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  writeFileSync(tmp, buf);
  try {
    return await runMediaRead(tmp, Math.max(10, Math.min(3600, Number(maxSeconds) || 1800)));
  } finally {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

// ── 漫画/番剧信息（AniList 为主，Bangumi 隧道通时优先）──────────────
function runComicInfo(args) {
  return new Promise((resolve, reject) => {
    execFile(PY, [`${ROOT}/comic_info.py`, ...args], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) reject(new Error(String(stderr || error.message).slice(0, 300)));
      else resolve(String(stdout || stderr).trim());
    });
  });
}

async function comicInfo({ query, id, detail = false } = {}) {
  if (id) return await runComicInfo(['detail', String(id)]);
  const kw = String(query ?? '').trim();
  if (!kw) throw new Error('给 query（作品名）或 id');
  if (detail) return await runComicInfo(['detail', kw]);
  return await runComicInfo(['search', kw, '5']);
}

// ── 以图搜图（ascii2d / AnimeTrace / SauceNAO / TraceMoe / 搜图bot酱 / AI鉴别）──
function runAnimeSearch(imgUrl, sources) {
  const args = [`${ROOT}/anime_search.py`, 'url', imgUrl, ...sources];
  return new Promise((resolve, reject) => {
    execFile(PY, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) reject(new Error(String(stderr || error.message).slice(0, 300)));
      else resolve(String(stdout || stderr).trim());
    });
  });
}

async function animeSearch({ url, imageId, sources } = {}) {
  let target = String(url ?? '').trim();
  if (!target && imageId) {
    const idx = galleryIndex();
    const hit = (idx.items || []).find((x) => String(x.id) === String(imageId));
    if (!hit) throw new Error(`图库里没有 id=${imageId}`);
    target = hit.url;
  }
  if (!target) throw new Error('给 url（图片地址）或 imageId（图库里的 id）');
  if (!/^https?:/.test(target)) throw new Error('只支持 http(s) 图片地址');
  const list = Array.isArray(sources) && sources.length ? sources : ['tracemoe', 'ascii2d', 'animetrace', 'saucenao', 'soutubot', 'aidefect'];
  return await runAnimeSearch(target, list);
}

// ── 文字 / LaTeX → PNG ─────────────────────────────────────────────
const RENDER_PY = `${ROOT}/render.py`;

function renderText(cfg) {
  return new Promise((resolve, reject) => {
    const child = execFile(PY, [RENDER_PY], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 300)));
      else resolve(String(stdout).trim());
    });
    child.stdin.end(JSON.stringify(cfg));
  });
}

async function renderPng({ text, key, fontsize = 22, color = '#111111', bg = 'white', maxwidth = 1080 } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('text 不能为空');
  if (body.length > 3000) throw new Error('一次最多 3000 字，太长了');
  const out = join(GEN_DIR, `render-${Date.now()}.png`);
  const line = await renderText({ text: body, out, fontsize, color, bg, maxwidth });
  const [file, size, bytes] = line.split('|');
  if (!key) return `已渲染：${file}（${size}，${Math.round(Number(bytes) / 1024)}KB）`;
  await sendImageTo(key, readFileSync(file));
  return `已发到 ${key}：${size}，${Math.round(Number(bytes) / 1024)}KB`;
}

// ── 自我形象（昵称 / 头像）──────────────────────────────────────────
async function qqProfileGet() {
  const info = await onebotCall('get_login_info', {});
  const d = info?.data ?? info ?? {};
  return `当前：昵称「${d.nickname ?? '?'}」，QQ ${d.user_id ?? '?'}`;
}

async function qqNameSet({ nickname } = {}) {
  const name = String(nickname ?? '').trim();
  if (!name) throw new Error('nickname 不能为空');
  if (name.length > 12) throw new Error('昵称最多 12 个字，别写一长串');
  const r = await onebotCall('set_qq_profile', { nickname: name });
  const ok = r?.retcode === 0 || r?.status === 'ok';
  return ok ? `昵称已改成「${name}」` : `改昵称失败：${JSON.stringify(r).slice(0, 160)}`;
}

async function qqAvatarSet({ path: localPath, url } = {}) {
  let buf;
  if (localPath) {
    const abs = String(localPath);
    if (!abs.startsWith(`${ROOT}/`)) throw new Error('path 必须落在  下');
    buf = readFileSync(abs);
  } else if (url) {
    const res = await fetch(String(url), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error('给 path（服务器上的图片）或 url');
  }
  if (buf.length > 4 * 1024 * 1024) throw new Error('头像图太大（上限 4MB）');
  const isImg = (buf[0] === 0xff && buf[1] === 0xd8) || buf.toString('ascii', 1, 4) === 'PNG';
  if (!isImg) throw new Error('不是 JPEG/PNG 图片');
  const r = await onebotCall('set_qq_avatar', { file: `base64://${buf.toString('base64')}` });
  const ok = r?.retcode === 0 || r?.status === 'ok';
  return ok ? `头像已更换（${Math.round(buf.length / 1024)}KB）` : `换头像失败：${JSON.stringify(r).slice(0, 160)}`;
}

// ── B站私信 ─────────────────────────────────────────────────────────
function runBiliDm(args, timeout = 40000) {
  return new Promise((resolve, reject) => {
    execFile(PY, [`${ROOT}/bili_dm.py`, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

async function biliDmList() {
  return await runBiliDm(['sessions']) || '没有私信会话。';
}

async function biliDmRead({ talker, size = 20 } = {}) {
  if (!talker) throw new Error('需要 talker（bili_dm_list 里的 talker 值）');
  return await runBiliDm(['msgs', String(talker), String(Math.min(50, Number(size) || 20))]);
}

async function biliDmSend({ to, message } = {}) {
  if (!to || !message) throw new Error('需要 to（收件人 mid）和 message');
  return await runBiliDm(['send', String(to), String(message).slice(0, 500)], 45000);
}

// ── B站互动（@我的 / 回复我的 / 回帖）──────────────────────────────
function runBiliInteract(args, timeout = 40000) {
  return new Promise((resolve, reject) => {
    execFile(PY, [`${ROOT}/bili_interact.py`, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

async function biliFeed({ limit = 8 } = {}) {
  return await runBiliInteract(['feed']) || '没有新的 @ 或回复。';
}

async function biliReply({ oid, type = 1, root = 0, parent = 0, message } = {}) {
  if (!oid || !message) throw new Error('需要 oid 和 message');
  const payload = JSON.stringify({ oid, type, root, parent, message: String(message).slice(0, 900) });
  return await runBiliInteract(['reply', payload], 45000);
}

// ── B站扫码登录（交给独立进程，避免 MCP 进程退出就断）───────────────
function biliLogin({ key } = {}) {
  if (!key) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const child = spawn(PY, [`${ROOT}/bili_login.py`, String(key)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return '二维码马上发到聊天，用 B站 App 扫。扫码/过期/失败都会回你一句。';
}

// ── 文档生成：markdown-ish → blocks / slides ────────────────────────
const OFFICE_MAKE = `${ROOT}/office_make.py`;

function markdownToBlocks(md) {
  const out = [];
  const lines = String(md).split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i += 1; continue; }
    if (/^```/.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push({ type: 'code', text: buf.join('\n') });
      continue;
    }
    if (/^\|.*\|$/.test(line) && /^\|[-: |]+\|$/.test((lines[i + 1] ?? '').trim())) {
      const rows = [];
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      rows.push(cells(line));
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test((lines[i] ?? '').trim())) { rows.push(cells(lines[i])); i += 1; }
      out.push({ type: 'table', rows });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push({ type: `h${h[1].length}`, text: h[2] }); i += 1; continue; }
    const b = /^[-*+]\s+(.*)$/.exec(line);
    if (b) { out.push({ type: 'bullet', text: b[1] }); i += 1; continue; }
    const n = /^\d+[.)]\s+(.*)$/.exec(line);
    if (n) { out.push({ type: 'num', text: n[1] }); i += 1; continue; }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { out.push({ type: 'quote', text: q[1] }); i += 1; continue; }
    out.push({ type: 'p', text: line });
    i += 1;
  }
  return out;
}

// Gemini修改：支持 v2 宽屏卡片 PPT（--- 分页、cards/cols/steps、Markdown 表格、takeaway、section/title/subtitle/meta）
function markdownToSlides(md) {
  const slides = [];
  let cur = null;
  let blockKey = ''; // 'cards' | 'cols' | 'steps' | ''
  let curItem = null;
  let subListKey = ''; // 'bullets' inside cols

  const flushItem = () => {
    if (cur && curItem && blockKey) {
      cur[blockKey] = cur[blockKey] || [];
      cur[blockKey].push(curItem);
    }
    curItem = null;
    subListKey = '';
  };
  const push = () => {
    flushItem();
    if (cur) slides.push(cur);
    cur = null;
    blockKey = '';
  };
  const ensureCur = () => { if (!cur) cur = { title: '开篇', bullets: [] }; };

  const lines = String(md ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (/^---+$/.test(line)) {
      if (cur) push();
      cur = { bullets: [] };
      continue;
    }

    // Markdown 表格：| 列1 | 列2 |
    if (/^\|.*\|$/.test(line)) {
      flushItem();
      blockKey = '';
      ensureCur();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (!cur.table) cur.table = [];
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // 跳过对齐分隔行
      cur.table.push(cells(line));
      if (!cur.layout || cur.layout === 'bullets') cur.layout = 'table';
      continue;
    }

    // Gemini修改：支持 chart JSON 配置行
    const chartM = /^chart[:：]\s*(\{[\s\S]+\})$/i.exec(line);
    if (chartM && !/^-\s+/.test(line)) {
      flushItem();
      blockKey = '';
      ensureCur();
      try {
        cur.chart = JSON.parse(chartM[1]);
        if (!cur.layout || cur.layout === 'bullets') cur.layout = 'chart';
        continue;
      } catch { /* 非法 JSON 时继续按普通行处理 */ }
    }

    // 元数据字段：layout / section / title / subtitle / meta / takeaway
    const metaM = /^(layout|版式|section|title|subtitle|meta|takeaway|leftTitle|rightTitle)[:：]\s*(.+)$/i.exec(line);
    if (metaM && !/^-\s+/.test(line)) {
      flushItem();
      blockKey = '';
      ensureCur();
      const k = metaM[1].toLowerCase();
      const val = metaM[2].trim();
      if (k === 'layout' || k === '版式') cur.layout = val.toLowerCase();
      else if (k === 'lefttitle') cur.leftTitle = val;
      else if (k === 'righttitle') cur.rightTitle = val;
      else cur[k] = val;
      continue;
    }

    // 块级列表头：cards: / cols: / steps:
    const blkM = /^(cards|cols|steps)[:：]\s*$/i.exec(line);
    if (blkM) {
      flushItem();
      ensureCur();
      blockKey = blkM[1].toLowerCase();
      continue;
    }

    // Gemini修改：块级子元素兼容更多字段别名（step/name/description/text/content）
    if (blockKey && /^-\s+(title|heading|value|label|desc|description|body|text|content|step|name)[:：]\s*(.*)$/i.test(line)) {
      flushItem();
      const m2 = /^-\s+([a-zA-Z]+)[:：]\s*(.*)$/.exec(line);
      curItem = { [m2[1].toLowerCase()]: m2[2].trim().replace(/^["']|["']$/g, '') };
      continue;
    }

    // 块内属性：value / label / desc / description / title / body / text / content / heading / step / name / bullets:
    if (blockKey && curItem) {
      if (/^bullets[:：]\s*$/i.test(line)) {
        subListKey = 'bullets';
        curItem.bullets = curItem.bullets || [];
        continue;
      }
      if (subListKey === 'bullets' && /^[-*+]\s+/.test(line)) {
        curItem.bullets.push(line.replace(/^[-*+]\s+/, '').trim());
        continue;
      }
      const propM = /^(title|heading|value|label|desc|description|body|text|content|step|name)[:：]\s*(.*)$/i.exec(line);
      if (propM) {
        subListKey = '';
        curItem[propM[1].toLowerCase()] = propM[2].trim().replace(/^["']|["']$/g, '');
        continue;
      }
    }

    // 配图：![说明](地址)
    const pic = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(line);
    if (pic) {
      flushItem();
      blockKey = '';
      ensureCur();
      cur.image = pic[1].trim();
      continue;
    }

    // 分栏：左 | 右
    const pair = /^(.+?)\s*\|\s*(.+)$/.exec(line);
    if (pair && cur && cur.layout === 'two-col') {
      (cur.left = cur.left || []).push(pair[1].trim());
      (cur.right = cur.right || []).push(pair[2].trim());
      continue;
    }

    // 标题开新页
    if (/^#{1,2}\s+/.test(line)) {
      push();
      cur = { title: line.replace(/^#{1,2}\s+/, ''), bullets: [] };
      continue;
    }

    ensureCur();
    cur.bullets.push(line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''));
  }
  push();
  return slides.filter((s) => s.title || s.layout === 'cover' || (s.bullets && s.bullets.length) || (s.cards && s.cards.length) || (s.cols && s.cols.length) || (s.table && s.table.length));
}

// ── 记忆库（LOD 分片）──────────────────────────────────────────────
async function memoryRecall({ need = '', budget = 1500 } = {}) {
  const r = mem.recall(String(need), Math.max(400, Math.min(4000, Number(budget) || 1500)));
  if (!r.files.length) {
    const tree = mem.tree().map((c) => `  ${c.category}/ ${c.files.length} 个`).join('\n');
    return `记忆库没有匹配「${need}」的碎片。当前结构：\n${tree}`;
  }
  const body = r.files.map((f) => `- ${f.path}｜${f.title}｜${f.lines} 行｜${f.lod}｜分 ${f.score.toFixed(1)}`).join('\n');
  return `允许读取 ${r.files.length} 个碎片（预算 ${r.budget}，估算 ${r.used}）：\n${body}\n\n读正文用 memory_open；只有真要细节时才展开 l2。`;
}

async function memoryOpen({ path: rel, maxLines = 120 } = {}) {
  const r = mem.readFragment(String(rel), Math.max(10, Math.min(400, Number(maxLines) || 120)));
  return `${r.path}${r.truncated ? '（已截断）' : ''}\n${'-'.repeat(18)}\n${r.text}`;
}

async function memoryWrite({ category, slug, lod = 'l1', content, append = false } = {}) {
  const r = mem.writeFragment({ category, slug, lod, content, append: Boolean(append) });
  return `已写入 ${r.path}（${r.lod}，${r.lines} 行）`;
}

async function memoryPatch({ path: rel, old, replacement } = {}) {
  if (!old) throw new Error('old 不能为空：要精确到能唯一定位的那几行');
  const r = mem.patchFragment({ path: String(rel), old, replacement: String(replacement ?? '') });
  return `已就地修改 ${r.path}（只动命中的那几行）`;
}

async function memoryMove({ path: rel, toCategory, rename } = {}) {
  const r = mem.moveFragment({ path: String(rel), toCategory, rename });
  return r.moved === false ? `${r.path} 已在目标位置` : `已移动：${r.from ?? rel} → ${r.path}`;
}

async function memoryTree({ category } = {}) {
  const t = mem.tree();
  const picked = category ? t.filter((c) => c.category === String(category)) : t;
  if (!picked.length) return '（空）';
  return picked.map((c) => `${c.category}/\n${c.files.map((f) => `  ${f.name}（${f.lines} 行）`).join('\n') || '  (空)'}`).join('\n');
}

// B站专栏正文：www.bilibili.com/read/cv… 是前端渲染（HTML 只有空壳），
// 但 read/mobile?id= 是服务端渲染的，正文在 <div class="opus-module-content"> 里。
function biliArticleId(input) {
  const s = String(input ?? '').trim();
  let m = /^\d+$/.exec(s);
  if (m) return s;
  m = /read\/cv(\d+)/i.exec(s);
  if (m) return m[1];
  m = /[?&]id=(\d+)/.exec(s);
  if (m) return m[1];
  return '';
}

async function biliArticle({ id, url, maxChars = 6000 } = {}) {
  const cv = biliArticleId(id || url);
  if (!cv) throw new Error('给 id（纯数字）或专栏链接');
  const limit = Math.max(500, Math.min(20000, Number(maxChars) || 6000));
  const target = `https://www.bilibili.com/read/mobile?id=${cv}`;
  const res = await fetch(target, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.bilibili.com/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`);
  const html = await res.text();
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s*-\s*哔哩哔哩\s*$/,'').trim();
  let start = html.indexOf('opus-module-content');
  if (start < 0) {
    // 兜底：整个页面剥标签（导航会有噪声，但总比没有强）
    const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (body.length > 200) {
      return `【${title || 'cv' + cv}】cv${cv}（无正文容器，整页兜底）\n${body.slice(0, limit)}`;
    }
    throw new Error(`页面里没有正文（长度 ${html.length}，可能是风控页）`);
  }
  // 从容器标签的 '>' 之后开始，避免把 class 属性文本带进正文
  const gt = html.indexOf('>', start);
  let seg = html.slice(gt > 0 ? gt + 1 : start);
  seg = seg.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<img[^>]*>/gi, '[图]');
  let text = seg.replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  if (!text) return `专栏 cv${cv} 没抽到正文。`;
  return `【${title || '专栏 cv' + cv}】cv${cv}  ${text.length} 字\n${text.slice(0, limit)}${text.length > limit ? `\n…[截断，原长 ${text.length}]` : ''}`;
}


// ── 视频转写 ───────────────────────────────────────────────────────────────
// B站：pagelist -> playurl(fnval=16) 取 dash 音频流（不需要 wbi 签名），下载后跑本地 ASR。
// 直链：mp4/m4a/wav 直接下。QQ 视频消息：桥接会把 url 透出，传 url 即可。
function parseBvid(input) {
  const s = String(input ?? '').trim();
  const m = /(BV[0-9A-Za-z]{10})/.exec(s);
  if (m) return m[1];
  return '';
}

async function biliVideoMeta(bvid) {
  const pg = await getJSON(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
    headers: { referer: 'https://www.bilibili.com/' },
  });
  const first = (pg?.data ?? [])[0];
  if (!first?.cid) throw new Error(`拿不到 ${bvid} 的分P信息`);
  const view = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  return {
    cid: first.cid,
    title: first.part || view?.data?.title || bvid,
    duration: Number(view?.data?.duration) || 0,
  };
}

async function biliAudioUrl(bvid, cid) {
  const pu = await getJSON(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1`,
    { headers: { referer: `https://www.bilibili.com/video/${bvid}` } },
  );
  const audios = pu?.data?.dash?.audio ?? [];
  if (!audios.length) throw new Error('这个视频没有 dash 音频流（可能是直播回放/付费内容）');
  const best = audios.slice().sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  return best.baseUrl || best.base_url;
}

async function videoTranscribe({ url, bvid, maxSeconds = 900, maxChars = 12000 } = {}) {
  const limit = Math.max(30, Math.min(1800, Number(maxSeconds) || 300));
  const chars = Math.max(500, Math.min(20000, Number(maxChars) || 6000));
  mkdirSync(DOC_DIR, { recursive: true });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const audioPath = join(DOC_DIR, `vid-${stamp}.m4a`);
  let title = '';
  let duration = 0;
  let srcLabel = '';

  const bv = parseBvid(bvid || url);
  if (bv) {
    const meta = await biliVideoMeta(bv);
    title = meta.title;
    duration = meta.duration;
    srcLabel = `B站 ${bv}`;
    const stream = await biliAudioUrl(bv, meta.cid);
    const res = await fetch(stream, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`音频流下载失败 HTTP ${res.status}`);
    writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));
  } else {
    const target = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('给 B站链接/视频直链，或本地路径');
    srcLabel = target;
    const res = await fetch(target, {
      headers: { 'user-agent': UA, referer: new URL(target).origin + '/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));
  }

  try {
    const { stdout, stderr } = await execFileAsync(PY, [
      `${ROOT}/asr.py`, audioPath, '--max-seconds', String(limit),
    ], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    const text = String(stdout ?? '').trim();
    if (!text) {
      const why = String(stderr ?? '').trim().slice(0, 200);
      return `${srcLabel}${title ? `【${title}】` : ''}\n没识别出语音内容${why ? `（${why}）` : '（可能是纯音乐/BGM 无人声）'}。`;
    }
    const head = `${srcLabel}${title ? `【${title}】` : ''}${duration ? ` ${Math.floor(duration / 60)}分${duration % 60}秒` : ''}｜识别 ${text.length} 字`;
    return `${head}\n${text.slice(0, chars)}${text.length > chars ? `\n…[截断，原长 ${text.length}]` : ''}`;
  } finally {
    try { unlinkSync(audioPath); } catch { /* ignore */ }
  }
}


// ── 聊天记录查询 ───────────────────────────────────────────────────────────
// 走 OneBot 的 get_group_msg_history / get_friend_msg_history，
// 可以查「和某个人的私聊」或「某个群」的消息，不受当前会话限制。
function segsToPlain(segs) {
  if (typeof segs === 'string') return segs;
  const out = [];
  for (const s of segs ?? []) {
    const d = s?.data ?? {};
    switch (s?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': out.push(d.qq === 'all' ? '@全体' : `@${d.qq ?? ''}`); break;
      case 'image': out.push('[图片]'); break;
      case 'face': out.push('[表情]'); break;
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': out.push('[引用]'); break;
      default: break;
    }
  }
  return out.join('').trim();
}

const fmtTime = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function loadAllowedSessionKeys(scope = 'all') {
  const s = String(scope || 'all').toLowerCase();
  const keys = [];
  const seen = new Set();
  const push = (k) => { if (!seen.has(k)) { seen.add(k); keys.push(k); } };
  try {
    const cfg = JSON.parse(readFileSync(BRIDGE_CONFIG, 'utf8'));
    const allow = cfg?.allow ?? {};
    const selfQQ = String(cfg?.selfQQ ?? '');  // 机器人自己的 QQ 号，在 config.json 的 selfQQ 里填
    if (s !== 'private') {
      for (const g of allow.groups ?? []) {
        const id = String(g ?? '').trim();
        if (/^\d+$/.test(id)) push(`group:${id}`);
      }
    }
    if (s !== 'groups') {
      const priv = [...(allow.private ?? [])];
      if (cfg?.ownerQQ) priv.push(String(cfg.ownerQQ));
      for (const p of priv) {
        const id = String(p ?? '').trim();
        if (/^\d+$/.test(id) && id !== selfQQ) push(`private:${id}`);
      }
    }
  } catch { /* ignore */ }
  return keys.length
    ? keys
    : [];  // 没配白名单时不给任何默认会话，调用方应显式传 keys
}

async function fetchChatHistoryItems({ key, count = 20, keyword } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  const n = Math.max(1, Math.min(100, Number(count) || 20));

  const data = kind === 'group'
    ? await onebotCall('get_group_msg_history', { group_id: Number(target), count: n })
    : await onebotCall('get_friend_msg_history', { user_id: Number(target), count: n });

  const raw = data?.messages ?? data?.message ?? [];
  const msgs = (Array.isArray(raw) ? raw : []).map((msg) => ({
    ts: Number(msg.time ?? msg.timestamp) || 0,
    time: fmtTime(msg.time ?? msg.timestamp),
    sender: String(msg.sender?.card || msg.sender?.nickname || msg.sender?.user_id || msg.user_id || '?'),
    selfId: String(msg.sender?.user_id ?? msg.user_id ?? ''),
    text: segsToPlain(msg.message ?? msg.raw_message ?? ''),
  })).filter((x) => x.text);

  const kw = String(keyword ?? '').trim().toLowerCase();
  const filtered = kw
    ? msgs.filter((x) => x.text.toLowerCase().includes(kw) || x.sender.toLowerCase().includes(kw) || x.selfId.includes(kw))
    : msgs;
  return { key: `${kind}:${target}`, total: msgs.length, items: filtered };
}

function formatChatBlock({ key, total, items }, keyword = '') {
  const kw = String(keyword ?? '').trim();
  const head = `「${key}」最近 ${items.length} 条${kw ? `（关键词「${kw}」，总 ${total}）` : ''}：`;
  const lines = items.map((x) => {
    const who = x.selfId && x.sender !== x.selfId ? `${x.sender}(${x.selfId})` : x.sender;
    return `${x.time} ${who}: ${clip(x.text, 200)}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

async function chatHistory({ key, count = 20, keyword } = {}) {
  const res = await fetchChatHistoryItems({ key, count, keyword });
  const kw = String(keyword ?? '').trim();
  if (!res.items.length) {
    return kw ? `「${res.key}」最近 ${res.total} 条里没有含「${kw}」的。` : `「${res.key}」没拿到消息。`;
  }
  const body = formatChatBlock(res, kw);
  // Gemini修改：爬楼返回防人机化后置约束
  const hint = res.items.length >= 15
    ? '\n提示：若用于给群友省流总结，只用 2~3 条 30 字内简短口语归纳核心八卦，严禁逐条复述或列清单。'
    : '';
  return body + hint;
}

// 跨会话找人/总览：覆盖全部白名单群聊与私聊；支持关键词搜索，也支持不传关键词直接总览各会话最新动态
async function chatSearch({ keyword, keys, scope = 'all', perKey } = {}) {
  const kw = String(keyword ?? '').trim();
  const targets = Array.isArray(keys) && keys.length ? keys : loadAllowedSessionKeys(scope);
  const defaultPer = kw ? 30 : 8;
  const per = Math.max(1, Math.min(100, Number(perKey) || defaultPer));
  const results = await Promise.all(targets.map(async (k) => {
    try {
      const res = await fetchChatHistoryItems({ key: k, count: per, keyword: kw });
      if (!res.items.length) return null;
      const lastTs = res.items[res.items.length - 1]?.ts || 0;
      return { res, lastTs };
    } catch {
      return null;
    }
  }));
  const hits = results.filter(Boolean).sort((a, b) => b.lastTs - a.lastTs);
  if (!hits.length) {
    return kw ? `全部群聊与私聊最近记录里没有含「${kw}」的。` : '所有白名单会话都没有拿到最近消息。';
  }
  return hits.map((h) => formatChatBlock(h.res, kw)).join('\n\n');
}

// ── [Agent更新 / 新增Skill] 实时网页与 B站链接/BV 解析 ─────────────────────────
async function resolveBiliShortLink(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    return res.url || url;
  } catch {
    return url;
  }
}

async function webLinkParse({ input, url } = {}) {
  let raw = String(input || url || '').trim();
  if (!raw) throw new Error('请提供网页 URL、b23.tv 短链或 B站 BV/cv 号');

  if (/b23\.tv\/[0-9A-Za-z]+/i.test(raw)) {
    const m = /(https?:\/\/b23\.tv\/[0-9A-Za-z]+)/i.exec(raw);
    if (m) raw = await resolveBiliShortLink(m[1]);
  }

  const cvMatch = /bilibili\.com\/read\/cv(\d+)/i.exec(raw) || /^cv(\d+)$/i.exec(raw);
  if (cvMatch) {
    return biliArticle({ id: cvMatch[1], maxChars: 1200 });
  }

  const bv = parseBvid(raw);
  if (bv) {
    const view = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
    const d = view?.data;
    if (!d?.bvid) throw new Error(`拿不到 ${bv} 的视频信息（可能已失效或下架）`);
    const aid = d.aid;
    const durMin = Math.floor((Number(d.duration) || 0) / 60);
    const durSec = (Number(d.duration) || 0) % 60;
    const views = Number(d.stat?.view || 0).toLocaleString('zh-CN');
    const likes = Number(d.stat?.like || 0).toLocaleString('zh-CN');
    let hotComments = [];
    if (aid) {
      try {
        const rep = await biliGet(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=5`);
        const replies = rep?.data?.replies ?? [];
        hotComments = replies.slice(0, 3).map((r) => {
          const uname = r?.member?.uname || '路人';
          const msg = String(r?.content?.message || '').replace(/\s+/g, ' ').trim();
          return msg ? `${uname}: ${clip(msg, 60)}` : '';
        }).filter(Boolean);
      } catch { /* 热评拉取失败不影响主信息 */ }
    }
    const out = [
      `B站视频：${d.title || bv}`,
      `UP主：${d.owner?.name || '未知'}｜播放：${views}｜赞：${likes}｜时长：${durMin}分${durSec}秒`,
      d.desc ? `简介：${clip(String(d.desc).replace(/\s+/g, ' ').trim(), 160)}` : '',
      hotComments.length ? `热评：\n- ${hotComments.join('\n- ')}` : '',
      '提示：请消化后用 30 字以内简短口语吐槽，严禁照抄清单。',
    ].filter(Boolean);
    return out.join('\n');
  }

  const targetMatch = /(https?:\/\/[^\s]+)/i.exec(raw);
  const target = targetMatch ? targetMatch[1] : (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const res = await fetch(target, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`网页抓取失败 HTTP ${res.status}`);
  const ct = String(res.headers.get('content-type') || '');
  const body = await res.text();
  if (!/html|xml/i.test(ct) && !/<html/i.test(body.slice(0, 500))) {
    return `文本摘要：${clip(body.replace(/\s+/g, ' ').trim(), 600)}\n提示：请消化后用 30 字以内简短口语回复。`;
  }
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const metaDesc = (/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i.exec(body)?.[1]
    || /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i.exec(body)?.[1]
    || '').replace(/\s+/g, ' ').trim();
  const plain = body
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  const imgs = extractContentImages(body, res.url || target, 6);
  const imgLine = imgs.length
    ? `【网页内嵌统计图表与图片列表】\n${imgs.map((im, i) => `${i + 1}. ${im.alt ? `[${im.alt}] ` : ''}${im.url}`).join('\n')}`
    : '';
  const lines = [
    title ? `标题：${clip(title, 100)}` : '',
    metaDesc ? `摘要：${clip(metaDesc, 200)}` : '',
    plain ? `正文片段：${clip(plain, 500)}` : '',
    imgLine,
    '提示：请消化后用 30 字以内简短口语回复，严禁照抄原文或列清单。',
  ].filter(Boolean);
  return lines.join('\n') || '网页内容为空。';
}

// ── [Agent更新 / 新增Skill] 持久化定时唤醒与验收工具 ─────────────────────────
const REMINDERS_FILE = `${ROOT}/reminders.json`;

function loadReminders() {
  try {
    const d = JSON.parse(readFileSync(REMINDERS_FILE, 'utf8'));
    return Array.isArray(d?.items) ? d.items : [];
  } catch {
    return [];
  }
}

function saveReminders(items) {
  writeFileSync(REMINDERS_FILE, JSON.stringify({ items }, null, 2), 'utf8');
}

function parseTriggerTimeMs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('triggerTime 不能为空');
  const rel = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|秒|分|分钟|小时|天)$/i.exec(s);
  if (rel) {
    const val = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = (unit === 's' || unit === 'sec' || unit === '秒') ? 1000
      : (unit === 'm' || unit === 'min' || unit === '分' || unit === '分钟') ? 60000
      : (unit === 'h' || unit === 'hr' || unit === '小时') ? 3600000
      : 86400000;
    return Date.now() + Math.max(5000, Math.round(val * mult));
  }
  const abs = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (abs) {
    const [, y, mo, d, h, mi, se] = abs;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0));
    const ts = dt.getTime();
    if (!Number.isFinite(ts)) throw new Error('无效的日期时间');
    return ts;
  }
  const hm = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (hm) {
    const now = new Date();
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hm[1]), Number(hm[2]), 0);
    if (dt.getTime() <= Date.now()) dt.setDate(dt.getDate() + 1);
    return dt.getTime();
  }
  throw new Error('triggerTime 格式支持：30m / 2h / 1d / HH:mm / YYYY-MM-DD HH:mm');
}

function fmtLocalDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function qqScheduleReminder({ action = 'list', targetType, targetId, triggerTime, content, repeat = 'none', id } = {}) {
  const act = String(action || 'list').toLowerCase();
  const items = loadReminders();

  if (act === 'list') {
    if (!items.length) return '当前没有待触发的定时提醒。';
    return items.map((it) => (
      `[${it.id}] ${fmtLocalDateTime(it.triggerAt)}｜${it.targetType}:${it.targetId}`
      + `${it.repeat && it.repeat !== 'none' ? `（重复:${it.repeat}）` : ''}｜${it.content}`
    )).join('\n');
  }

  if (act === 'remove') {
    const rid = String(id ?? '').trim();
    if (!rid) throw new Error('action=remove 需要提供 id');
    const next = items.filter((it) => it.id !== rid);
    if (next.length === items.length) return `找不到 id 为 ${rid} 的定时提醒。`;
    saveReminders(next);
    return `已删除定时提醒 ${rid}。`;
  }

  if (act === 'add') {
    const tt = String(targetType ?? '').trim().toLowerCase();
    const tid = String(targetId ?? '').trim();
    const msg = String(content ?? '').trim();
    if (!['private', 'group'].includes(tt)) throw new Error('targetType 必须是 private 或 group');
    if (!/^\d+$/.test(tid)) throw new Error('targetId 必须是纯数字 QQ 号或群号');
    if (!msg) throw new Error('content 不能为空');
    const rep = ['none', 'daily', 'weekly'].includes(String(repeat || 'none').toLowerCase())
      ? String(repeat || 'none').toLowerCase()
      : 'none';
    const triggerAt = parseTriggerTimeMs(triggerTime);
    const newId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    items.push({ id: newId, targetType: tt, targetId: tid, triggerAt, content: clip(msg, 200), repeat: rep, createdAt: Date.now() });
    saveReminders(items);
    return `已设定定时提醒 [${newId}]：将于 ${fmtLocalDateTime(triggerAt)} 在 ${tt}:${tid} 唤醒执行「${clip(msg, 60)}」${rep !== 'none' ? `（${rep}）` : ''}。`;
  }

  throw new Error('action 必须是 add / list / remove');
}

let reminderTickBusy = false;
async function checkAndDispatchReminders() {
  if (reminderTickBusy) return;
  reminderTickBusy = true;
  try {
    const items = loadReminders();
    if (!items.length) return;
    const now = Date.now();
    const due = [];
    const keep = [];
    for (const it of items) {
      if (Number(it.triggerAt) <= now) {
        due.push(it);
        if (it.repeat === 'daily') {
          keep.push({ ...it, triggerAt: Number(it.triggerAt) + 86400000 });
        } else if (it.repeat === 'weekly') {
          keep.push({ ...it, triggerAt: Number(it.triggerAt) + 7 * 86400000 });
        }
      } else {
        keep.push(it);
      }
    }
    if (!due.length) return;
    saveReminders(keep);

    let port = 3100;
    let token = '';
    try {
      const bcfg = JSON.parse(readFileSync(BRIDGE_CONFIG, 'utf8'));
      if (bcfg?.consolePort) port = Number(bcfg.consolePort);
      if (bcfg?.consoleToken) token = String(bcfg.consoleToken);
    } catch { /* use default */ }

    for (const it of due) {
      const key = `${it.targetType}:${it.targetId}`;
      const prompt = `【定时唤醒 · 提醒/验收】约定时间到了！请立刻调用 qq_send_message 在当前会话（${key}）用你一贯的角色口吻主动开口说话。\n`
        + `事由：${it.content}\n`
        + `注意：直接用自然语气提醒或查岗验收（30字以内短气泡），不要说"系统提醒我"或"定时任务触发了"。`;
      try {
        await fetch(`http://127.0.0.1:${port}/api/console/notify-ai`, {
          method: 'POST',
          headers: { 'x-console-token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, message: prompt }),
          signal: AbortSignal.timeout(15000),
        });
        log(`[reminder] 已触发唤醒 ${key}: ${it.content}`);
      } catch (e) {
        log(`[reminder] 唤醒失败 ${key}: ${e?.message ?? e}`);
      }
    }
  } finally {
    reminderTickBusy = false;
  }
}

setInterval(() => {
  void checkAndDispatchReminders().catch((e) => log('[reminder] tick err:', e?.message ?? e));
}, 15000).unref?.();

// ── [Agent更新 / 新增Skill] 今日运势与跑团骰子 ───────────────────────────────
const FORTUNE_LEVELS = ['大吉 ✨', '中吉 🌟', '小吉 🐾', '末吉 ☁️', '小凶 🌧️'];
const FORTUNE_GOOD = ['摸鱼喝奶茶', '群里水一发', '早睡不熬夜', '十连抽卡', '点歌听两首', '晒猫晒图', '抱抱毛绒玩具'];
const FORTUNE_BAD = ['立flag说稳了', '深夜吃夜宵', '强行对线', '盲目十连', '拖延DDL', '跟人抬杠'];

function funDiceFortune({ mode = 'fortune', qq = '', expr = '1d100' } = {}) {
  const m = String(mode || 'fortune').toLowerCase();
  if (m === 'dice') {
    const raw = String(expr || '1d100').trim().toLowerCase().replace(/\s+/g, '');
    const parsed = /^(\d{1,2})d(\d{1,5})([+-]\d{1,5})?$/.exec(raw);
    if (!parsed) throw new Error('骰子格式支持如 1d100、2d6、1d20+3');
    const cnt = Math.max(1, Math.min(20, Number(parsed[1])));
    const sides = Math.max(2, Math.min(10000, Number(parsed[2])));
    const mod = parsed[3] ? Number(parsed[3]) : 0;
    const rolls = Array.from({ length: cnt }, () => 1 + Math.floor(Math.random() * sides));
    const sum = rolls.reduce((a, b) => a + b, 0) + mod;
    return `掷骰 ${raw}：结果 [${rolls.join(', ')}]${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''} = ${sum}（请用简短回复点评）`;
  }

  const day = fmtLocalDateTime(Date.now()).slice(0, 10);
  const seed = `${String(qq || 'anon').trim()}:${day}:starcat`;
  const h = createHash('sha256').update(seed).digest();
  const level = FORTUNE_LEVELS[h[0] % FORTUNE_LEVELS.length];
  const score = 35 + (h[1] % 66);
  const good = FORTUNE_GOOD[h[2] % FORTUNE_GOOD.length];
  const bad = FORTUNE_BAD[h[3] % FORTUNE_BAD.length];
  return `今日运势（${day}｜${qq || '匿名'}）：${level}（运气值 ${score}/100）｜宜：${good}｜忌：${bad}｜提示：请用 30 字内自然口吻吐槽/点评，勿照搬格式。`;
}

// ── [Agent更新 / 新增Skill] 梗图加字工具 ─────────────────────────────────────
const MEME_CAPTION_PY = `${ROOT}/meme_caption.py`;

async function memeCaption({ key, text, position = 'bottom', bottomText = '', url, imageId } = {}) {
  const caption = String(text ?? '').trim();
  if (!caption) throw new Error('text 配字不能为空');
  mkdirSync(GEN_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const inPath = join(GEN_DIR, `meme-in-${stamp}.img`);
  const outPath = join(GEN_DIR, `meme-out-${stamp}.png`);

  let srcBuf = null;
  if (url) {
    const res = await fetch(String(url), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`原图下载失败 HTTP ${res.status}`);
    srcBuf = Buffer.from(await res.arrayBuffer());
  } else if (imageId) {
    const idx = galleryIndex();
    const hit = (idx?.items || []).find((x) => x.id.startsWith(String(imageId))); // Gemini修改：galleryIndex 返回 { items }
    if (!hit) throw new Error(`图库里找不到 ${imageId}`);
    srcBuf = readFileSync(join(GALLERY_DIR, hit.file));
  } else {
    // 未传图时优先从本地表情包随机挑一张作底图
    const cats = existsSync(STICKER_ROOT) ? readdirSync(STICKER_ROOT) : [];
    const pool = [];
    for (const c of cats) {
      const dir = join(STICKER_ROOT, c);
      try {
        for (const f of readdirSync(dir)) {
          if (/\.(gif|png|jpg|jpeg|webp)$/i.test(f)) pool.push(join(dir, f));
        }
      } catch { /* ignore */ }
    }
    if (!pool.length) throw new Error('没有可用底图，请传 url 或 imageId');
    srcBuf = readFileSync(pool[Math.floor(Math.random() * pool.length)]);
  }

  writeFileSync(inPath, srcBuf);
  try {
    const pyArgs = [MEME_CAPTION_PY, '--input', inPath, '--output', outPath, '--text', caption, '--position', String(position || 'bottom')];
    if (bottomText) pyArgs.push('--bottom', String(bottomText));
    await execFileAsync(PY, pyArgs, { timeout: 25000 });
    const outBuf = readFileSync(outPath);
    if (key) {
      await sendImageTo(key, outBuf);
      return `已生成梗图并发送到 ${key}（配字「${clip(caption, 20)}」）`;
    }
    return `梗图已生成：${outPath}（${Math.round(outBuf.length / 1024)}KB）`;
  } finally {
    try { unlinkSync(inPath); } catch { /* ignore */ }
  }
}

// ── [Gemini修改 / 第二阶段新增Skill] 读取 QQ 空间好友动态（qzone_feed，支持按会话过滤防串群）─────────
async function qzoneFeed({ key, targetUin, count = 8, cursor } = {}) {
  const n = Math.max(1, Math.min(20, Number(count) || 8));
  const keyMatch = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  const scopeKind = keyMatch ? keyMatch[1] : '';
  const scopeId = keyMatch ? keyMatch[2] : '';

  let allowedUins = null;
  if (scopeKind === 'group') {
    try {
      const members = await onebotCall('get_group_member_list', { group_id: Number(scopeId) });
      const arr = Array.isArray(members) ? members : (Array.isArray(members?.members) ? members.members : []);
      allowedUins = new Set(arr.map((m) => String(m?.user_id ?? '')).filter(Boolean));
    } catch { /* ignore if member list fails */ }
  } else if (scopeKind === 'private') {
    allowedUins = new Set([scopeId]);
  }

  if (targetUin && /^\d+$/.test(String(targetUin).trim())) {
    const tid = String(targetUin).trim();
    if (allowedUins && !allowedUins.has(tid)) {
      return `QQ ${tid} 不在当前会话（${key}）里，严禁把他的空间动态分享到无关群聊。`;
    }
  }

  let feeds = [];
  let nextCursor = '';
  const effectiveTarget = (targetUin && /^\d+$/.test(String(targetUin).trim()))
    ? String(targetUin).trim()
    : (scopeKind === 'private' ? scopeId : '');

  if (effectiveTarget) {
    const data = await onebotCall('get_qzone_msg_list', { target_uin: Number(effectiveTarget), pos: 0, num: n });
    feeds = Array.isArray(data?.msglist) ? data.msglist : (Array.isArray(data?.feeds) ? data.feeds : (Array.isArray(data) ? data : []));
  } else {
    const payload = { count: allowedUins ? Math.min(20, n * 2) : n };
    if (cursor) payload.cursor = String(cursor);
    else payload.page_num = 1;
    const data = await onebotCall('get_qzone_feeds', payload);
    feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    nextCursor = data?.next_cursor || '';
  }

  if (allowedUins && feeds.length) {
    feeds = feeds.filter((f) => f?.uin != null && allowedUins.has(String(f.uin)));
  }

  if (!feeds.length) {
    return key
      ? `当前会话（${key}）里的成员最近空间没有新动态（已自动过滤掉不在本群/本私聊的人）。`
      : '空间暂时没有刷到新动态。';
  }
  const lines = feeds.slice(0, n).map((f) => {
    const nick = String(f.nickname || f.name || f.uin || '好友');
    const uin = f.uin ? `(${f.uin})` : '';
    const t = f.time ? fmtTime(f.time) : '';
    const rawText = f.content || (f.html ? String(f.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
    const body = clip(rawText || (Array.isArray(f.images) && f.images.length ? '[发了照片]' : '[动态]'), 120);
    const imgs = Array.isArray(f.images) && f.images.length ? ` [${f.images.length}图]` : '';
    return `${t} ${nick}${uin}: ${body}${imgs}`;
  });
  return `空间最新动态（${lines.length} 条${key ? `｜已限定仅当前会话成员` : ''}${nextCursor ? `｜next_cursor=${nextCursor}` : ''}）：\n${lines.join('\n')}\n提示：仅限在当事人所在的群或本人私聊里自然提起，消化成 30 字内简短回复，严禁跨群转述。`;
}

// ── [Gemini修改 / 第二阶段新增Skill] 轻量 Edge-TTS 短语音发送（qq_send_tts_voice）──
// ── [TTS 增强] 语音文本清洗与情绪预设 ─────────────────────────
// 颜文字/Emoji 念不出来，必须先清洗；「自己」要保住，不能把自称拆成「本，喵」。
function sanitizeForCatGirlTTS(rawText) {
  const PH = '\u0001BENMIAO\u0001';
  const out = String(rawText ?? '')
    .replace(/自己/g, PH)
    .replace(/[（(][^（）()]{0,14}[ω✧؂∇￣▽•́︿•̀｀・ω・´^<>゜ﾟฅ๑⌒∀∂][^（）()]{0,14}[）)]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[～~]+/g, '……')
    .replace(/([^，。！？…\s])喵/g, '$1，喵')
    .replace(/[*^*_]{1,}$/g, '')
    .replace(/…{2,}/g, '……')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .split(PH).join('自己');
  return /[\u4e00-\u9fa5A-Za-z0-9]/.test(out) ? out : '';
}

const TTS_PRESETS = {
  energetic: { voice: 'zh-CN-XiaoyiNeural', rate: '+10%', pitch: '+8Hz' },
  playful:   { voice: 'zh-CN-XiaoyiNeural', rate: '+15%', pitch: '+12Hz' },
  sleepy:    { voice: 'zh-CN-XiaoxiaoNeural', rate: '-6%', pitch: '+4Hz' },
};

function autoTtsMood(now = Date.now()) {
  const h = new Date(now).getHours();
  return (h >= 23 || h < 6) ? 'sleepy' : 'energetic';
}

const ttsLastSentAt = new Map();

// ── [Gemini接入] 用 Gemini TTS 生成语音（走本地代理，失败自动回退 edge-tts）──
const GEMINI_CONF = `${ROOT}/gemini.json`;

function geminiConfig() {
  try { return JSON.parse(readFileSync(GEMINI_CONF, 'utf8')); } catch { return {}; }
}

const GEMINI_TTS_VOICES = {
  energetic: 'Aoede',
  playful: 'Kore',
  sleepy: 'Leda',
};

async function synthGeminiTts(text, moodKey) {
  const cfg = geminiConfig();
  if (!cfg.apiKey) throw new Error('gemini.json 缺 apiKey');
  const model = cfg.ttsModel || 'gemini-3.8-flash-tts';
  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  const payload = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICES[moodKey] || 'Aoede' } } },
    },
  };
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const reqPath = join(GEN_DIR, `gem-req-${stamp}.json`);
  const resPath = join(GEN_DIR, `gem-res-${stamp}.json`);
  mkdirSync(GEN_DIR, { recursive: true });
  writeFileSync(reqPath, JSON.stringify(payload), 'utf8');
  try {
    const { stdout } = await execFileAsync('curl', [
      '-s', '-m', '60',
      ...(cfg.proxy ? ['--proxy', String(cfg.proxy)] : []),
      '-H', 'content-type: application/json',
      '-d', `@${reqPath}`,
      '-o', resPath,
      '-w', '%{http_code}',
      `${base}/${model}:generateContent?key=${cfg.apiKey}`,
    ], { timeout: 70000 });
    const code = String(stdout || '').trim();
    if (code !== '200') {
      let detail = '';
      try { detail = String(JSON.parse(readFileSync(resPath, 'utf8'))?.error?.message || '').slice(0, 100); } catch { /* ignore */ }
      throw new Error(`Gemini TTS HTTP ${code}${detail ? '：' + detail : ''}`);
    }
    const j = JSON.parse(readFileSync(resPath, 'utf8'));
    const part = ((j.candidates || [])[0]?.content?.parts || []).find((p) => p.inlineData);
    if (!part?.inlineData?.data) throw new Error('Gemini 未返回音频');
    return Buffer.from(part.inlineData.data, 'base64');
  } finally {
    try { unlinkSync(reqPath); } catch { /* ignore */ }
    try { unlinkSync(resPath); } catch { /* ignore */ }
  }
}

async function qqSendTtsVoice({ key, text, voice = '', rate = '', pitch = '', mood = '', engine = 'auto', allowGroup = false } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 要写成 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  if (kind === 'group' && !allowGroup) {
    throw new Error('默认仅限私聊发送语音；若群友明确要求语音，请传 allowGroup=true');
  }
  const rawText = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!rawText) throw new Error('text 不能为空');
  const msg = sanitizeForCatGirlTTS(rawText);
  if (!msg) throw new Error('清洗后语音文本为空（原文可能全是颜文字或 Emoji），请换一句口语');
  if (msg.length > 80) throw new Error(`语音内容太长（清洗后 ${msg.length} 字，上限 80 字，保持 3~6 秒短语音）`);

  const moodKey = TTS_PRESETS[mood] ? mood : autoTtsMood();
  const preset = TTS_PRESETS[moodKey];

  const now = Date.now();
  const lastAt = ttsLastSentAt.get(m[0]) || 0;
  if (now - lastAt < 180000) {
    const waitS = Math.ceil((180000 - (now - lastAt)) / 1000);
    throw new Error(`语音发送冷却中（还需 ${waitS} 秒），严禁刷屏`);
  }

  mkdirSync(GEN_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // 引擎：默认先试 Gemini（音质更自然），不可用时自动回退 edge-tts
  const wantGemini = ['gemini', 'auto'].includes(String(engine || 'auto').toLowerCase());
  let buf = null;
  let usedEngine = 'edge';
  if (wantGemini) {
    try {
      buf = await synthGeminiTts(msg, moodKey);
      usedEngine = 'gemini';
    } catch (error) {
      log(`[TTS] Gemini 不可用，回退 edge-tts：${String(error?.message ?? error).slice(0, 90)}`);
      if (String(engine).toLowerCase() === 'gemini') throw error;
    }
  }
  if (!buf) {
    const mp3Path = join(GEN_DIR, `tts-${stamp}.mp3`);
    try {
      await execFileAsync(PY, [
        '-m', 'edge_tts',
        '--voice', String(voice || preset.voice),
        `--rate=${String(rate || preset.rate)}`,
        `--pitch=${String(pitch || preset.pitch)}`,
        '--text', msg,
        '--write-media', mp3Path,
      ], { timeout: 25000 });
      buf = readFileSync(mp3Path);
    } finally {
      try { unlinkSync(mp3Path); } catch { /* ignore */ }
    }
  }
  if (!buf || !buf.length) throw new Error('TTS 音频生成为空');

  const segs = [{ type: 'record', data: { file: `base64://${buf.toString('base64')}` } }];
  const data = kind === 'group'
    ? await onebotCall('send_group_msg', { group_id: Number(target), message: segs })
    : await onebotCall('send_private_msg', { user_id: Number(target), message: segs });
  ttsLastSentAt.set(m[0], now);
  return `已发送短语音到 ${m[0]}（${msg.length} 字，mood=${moodKey}，engine=${usedEngine}，message_id: ${data?.message_id ?? '?'}）`;
}

// ── [Gemini修改 / 新增Skill] 群聊「立 Flag 与名场面档案馆」(qq_quote_archive) ──
const QUOTE_ARCHIVE_FILE = `${ROOT}/quote_archive.json`;
const QUOTE_CARD_PY = `${ROOT}/quote_card.py`;

function loadQuoteArchive() {
  try {
    const d = JSON.parse(readFileSync(QUOTE_ARCHIVE_FILE, 'utf8'));
    return Array.isArray(d?.items) ? d.items : [];
  } catch {
    return [];
  }
}

function saveQuoteArchive(items) {
  writeFileSync(QUOTE_ARCHIVE_FILE, JSON.stringify({ items: items.slice(-500) }, null, 2), 'utf8');
}

async function qqQuoteArchive({ action = 'list', groupId, speaker, qq, quote, kind = 'flag', id, month, key, limit = 15 } = {}) {
  const act = String(action || 'list').toLowerCase();
  const items = loadQuoteArchive();
  const gid = groupId ? String(groupId).trim() : '';

  if (act === 'add') {
    const spk = String(speaker ?? '').trim();
    const txt = String(quote ?? '').trim();
    if (!gid || !/^\d+$/.test(gid)) throw new Error('action=add 需要纯数字 groupId');
    if (!spk || !txt) throw new Error('action=add 需要 speaker 和 quote');
    const k = ['flag', 'typo', 'quote'].includes(String(kind).toLowerCase()) ? String(kind).toLowerCase() : 'flag';
    const dup = items.find((x) => x.groupId === gid && x.speaker === spk && x.quote === txt);
    if (dup) return `这条语录已在档案中 [${dup.id}]：${dup.speaker}「${clip(dup.quote, 30)}」`;
    const nid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const date = fmtLocalDateTime(Date.now()).slice(0, 10);
    items.push({ id: nid, groupId: gid, speaker: clip(spk, 30), qq: qq ? String(qq).trim() : '', quote: clip(txt, 160), kind: k, date, ts: Date.now(), busted: false });
    saveQuoteArchive(items);
    return `已悄悄归档 [${nid}]（${k}｜${spk}｜${date}）：「${clip(txt, 40)}」`;
  }

  if (act === 'bust') {
    const targetId = String(id ?? '').trim();
    const hit = targetId
      ? items.find((x) => x.id === targetId)
      : [...items].reverse().find((x) => (!gid || x.groupId === gid) && (!speaker || x.speaker.includes(speaker)) && x.kind === 'flag' && !x.busted);
    if (!hit) return '没找到对应的 Flag 记录。';
    hit.busted = true;
    hit.bustedAt = fmtLocalDateTime(Date.now()).slice(0, 10);
    saveQuoteArchive(items);
    return `Flag 已标记破功 [${hit.id}]：${hit.speaker} 在 ${hit.date} 立下的「${hit.quote}」（可调 action=card&id=${hit.id} 生成公开处刑小卡片）。`;
  }

  if (act === 'remove') {
    const rid = String(id ?? '').trim();
    if (!rid) throw new Error('action=remove 需要 id');
    const next = items.filter((x) => x.id !== rid);
    if (next.length === items.length) return `找不到 id=${rid}`;
    saveQuoteArchive(next);
    return `已删除档案 ${rid}。`;
  }

  if (act === 'card') {
    mkdirSync(GEN_DIR, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const outPath = join(GEN_DIR, `quote-${stamp}.png`);
    if (month || (!id && kind === 'monthly')) {
      const m = String(month || fmtLocalDateTime(Date.now()).slice(0, 7)).trim();
      const pool = items.filter((x) => (!gid || x.groupId === gid) && String(x.date || '').startsWith(m));
      if (!pool.length) return `${m} 还没有收录群聊名场面。`;
      await execFileAsync(PY, [QUOTE_CARD_PY, '--mode', 'monthly', '--month', m, '--data', JSON.stringify(pool.slice(-10)), '--output', outPath], { timeout: 25000 });
      const buf = readFileSync(outPath);
      if (key) {
        await sendImageTo(key, buf);
        try { unlinkSync(outPath); } catch { /* ignore */ }
        return `已生成并发送《本群 ${m} 月度发疯语录图》（收录 ${pool.length} 条）到 ${key}`;
      }
      return `月度语录图已生成：${outPath}（${Math.round(buf.length / 1024)}KB）`;
    }

    const hit = id ? items.find((x) => x.id === String(id).trim()) : [...items].reverse().find((x) => !gid || x.groupId === gid);
    if (!hit) return '没有可生成卡片的语录记录。';
    await execFileAsync(PY, [QUOTE_CARD_PY, '--mode', 'single', '--data', JSON.stringify(hit), '--output', outPath], { timeout: 25000 });
    const buf = readFileSync(outPath);
    if (key) {
      await sendImageTo(key, buf);
      try { unlinkSync(outPath); } catch { /* ignore */ }
      return `已生成语录小卡片 [${hit.id}] 并发送到 ${key}`;
    }
    return `语录小卡片已生成：${outPath}（${Math.round(buf.length / 1024)}KB）`;
  }

  // list
  const n = Math.max(1, Math.min(50, Number(limit) || 15));
  const filtered = items.filter((x) => (!gid || x.groupId === gid) && (!speaker || x.speaker.includes(speaker)) && (!month || String(x.date || '').startsWith(month)));
  if (!filtered.length) return '档案馆暂时空空的，还没有收录名场面。';
  return filtered.slice(-n).reverse().map((x) => (
    `[${x.id}] ${x.date}｜${x.kind}${x.busted ? '(已破功)' : ''}｜${x.speaker}: ${x.quote}`
  )).join('\n');
}

// ── [Gemini修改 / 新增Skill] 跨群「脱敏吃瓜雷达」公共话题词池 (qq_topic_radar) ──
const TOPIC_RADAR_FILE = `${ROOT}/public_topics.json`;

function loadTopicRadar() {
  try {
    const d = JSON.parse(readFileSync(TOPIC_RADAR_FILE, 'utf8'));
    const cutoff = Date.now() - 7 * 86400000;
    return (Array.isArray(d?.items) ? d.items : []).filter((x) => Number(x?.updatedAt || 0) >= cutoff);
  } catch {
    return [];
  }
}

function saveTopicRadar(items) {
  writeFileSync(TOPIC_RADAR_FILE, JSON.stringify({ items: items.slice(-40) }, null, 2), 'utf8');
}

function sanitizePublicTopic(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('topic 不能为空');
  // 严格脱敏：拦截 QQ 号/群号、@、group:/private: 及私聊指向
  if (/(group|private):\d+/i.test(s) || /\b\d{5,12}\b/.test(s) || /@|私聊|群号|群里某人/.test(s)) {
    throw new Error('公共话题词池严格脱敏，禁止包含 QQ 号、群号、@ 或任何私聊/个人隐私信息');
  }
  return clip(s, 80);
}

async function qqTopicRadar({ action = 'list', topic, category = '热梗', id, limit = 8 } = {}) {
  const act = String(action || 'list').toLowerCase();
  const items = loadTopicRadar();

  if (act === 'add') {
    const clean = sanitizePublicTopic(topic);
    const cat = ['游戏', '番剧', '热梗', '科技', '日常'].includes(String(category)) ? String(category) : '热梗';
    const existing = items.find((x) => x.topic === clean);
    if (existing) {
      existing.heat = (Number(existing.heat) || 1) + 1;
      existing.updatedAt = Date.now();
      saveTopicRadar(items);
      return `公共话题热度+1 [${existing.id}]：${existing.topic}`;
    }
    const nid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    items.push({ id: nid, topic: clean, category: cat, heat: 1, updatedAt: Date.now() });
    saveTopicRadar(items);
    return `已收录脱敏公共话题 [${nid}]（${cat}）：${clean}`;
  }

  if (act === 'remove') {
    const rid = String(id ?? '').trim();
    const next = items.filter((x) => x.id !== rid);
    saveTopicRadar(next);
    return `已移除话题 ${rid}`;
  }

  if (!items.length) return '公共话题词池暂时为空。';
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  const picked = items.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)).slice(0, n);
  return `脱敏公共话题池（${picked.length} 条，严格不含群号/昵称）：\n`
    + picked.map((x) => `- [${x.id}] (${x.category}｜热度${x.heat}) ${x.topic}`).join('\n')
    + '\n提示：冷场时可挑 1 个自然抛出（如「听说最近大家都在聊…」），勿照抄格式。';
}

// ── [Gemini修改 / 新增Skill] 短视频抽关键帧看画面（video_peek）─────────────────
async function videoPeek({ url, bvid, path: localPath, frames = 6, maxSeconds = 60 } = {}) {
  const nFrames = Math.max(4, Math.min(9, Number(frames) || 6));
  const cols = nFrames <= 4 ? 2 : 3;
  const rows = Math.ceil(nFrames / cols);
  const maxSec = Math.max(5, Math.min(180, Number(maxSeconds) || 60));

  mkdirSync(DOC_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const vidPath = join(DOC_DIR, `peek-${stamp}.mp4`);
  const outImg = join(DOC_DIR, `peek-${stamp}.jpg`);
  let needCleanupVid = false;
  let srcInput = '';
  let label = '';

  const bv = parseBvid(bvid || url);
  if (localPath && existsSync(String(localPath))) {
    srcInput = String(localPath);
    label = basename(srcInput);
  } else if (bv) {
    const meta = await biliVideoMeta(bv);
    label = `B站 ${bv}【${clip(meta.title || bv, 36)}】`;
    const pu = await biliGet(`https://api.bilibili.com/x/player/playurl?bvid=${bv}&cid=${meta.cid}&qn=32&fnval=1`);
    const durl = pu?.data?.durl?.[0]?.url;
    if (!durl) throw new Error(`拿不到 ${bv} 的视频画面流`);
    const res = await fetch(durl, {
      headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bv}`, origin: 'https://www.bilibili.com', range: 'bytes=0-12582911' },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok && res.status !== 206) throw new Error(`视频流下载失败 HTTP ${res.status}`);
    writeFileSync(vidPath, Buffer.from(await res.arrayBuffer()));
    srcInput = vidPath;
    needCleanupVid = true;
  } else {
    const target = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('请提供视频直链 url、B站 bvid 或本地 path');
    label = '短视频';
    const res = await fetch(target, {
      headers: { 'user-agent': UA, referer: new URL(target).origin + '/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`视频下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 35 * 1024 * 1024) throw new Error(`视频过大（${Math.round(buf.length / 1024 / 1024)}MB，上限 35MB）`);
    writeFileSync(vidPath, buf);
    srcInput = vidPath;
    needCleanupVid = true;
  }

  try {
    // 探测时长以均匀抽帧（探测失败按 15 秒兜底）
    let dur = 15;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', srcInput,
      ], { timeout: 10000 });
      const parsed = parseFloat(String(stdout || '').trim());
      if (Number.isFinite(parsed) && parsed > 0.5) dur = Math.min(maxSec, parsed);
    } catch { /* fallback 15s */ }

    const fps = Math.max(0.05, nFrames / Math.max(1, dur));
    const vf = `fps=${fps.toFixed(4)},scale=320:-2:flags=lanczos,tile=${cols}x${rows}`;
    await execFileAsync('ffmpeg', [
      '-y', '-t', String(maxSec), '-i', srcInput,
      '-vf', vf, '-frames:v', '1', '-q:v', '4', outImg,
    ], { timeout: 30000 });

    if (!existsSync(outImg)) throw new Error('抽帧拼图未生成（视频可能损坏或无视频轨）');
    const imgBuf = readFileSync(outImg);
    const b64 = imgBuf.toString('base64');
    return {
      __mcpContent: [
        {
          type: 'text',
          text: `${label} 画面关键帧网格（截取约 ${Math.round(dur)} 秒，共 ${nFrames} 帧，${cols}×${rows} 行优先 左上→右下；${Math.round(imgBuf.length / 1024)}KB）。提示：请用 1~2 条 30 字内简短口语吐槽画面重点，严禁逐帧写长文列表。`,
        },
        { type: 'image', mimeType: 'image/jpeg', data: b64 },
      ],
    };
  } finally {
    if (needCleanupVid) { try { unlinkSync(vidPath); } catch { /* ignore */ } }
    try { unlinkSync(outImg); } catch { /* ignore */ }
  }
}


// ── [状态系统] 机器人的情绪/发情状态（0-100，五档，发情期每月 18-20 日）──────
// ── [工具] 专业数据图表渲染 chart_generator（matplotlib，300dpi，中文字体）──
const CHART_PY = `${ROOT}/chart_gen.py`;

async function chartGenerator({ chartType = 'bar', title = '', labels = [], datasets = [], style = 'academic', unit = '', width, height, key } = {}) {
  const ctype = String(chartType || 'bar').toLowerCase();
  if (!['bar', 'line', 'pie', 'radar'].includes(ctype)) {
    throw new Error('chartType 只支持 bar / line / pie / radar');
  }
  const sets = (Array.isArray(datasets) ? datasets : []).filter(Boolean);
  if (!sets.length) throw new Error('datasets 不能为空，形如 [{"name":"同比","values":[5.3,5.0]}]');
  let lbls = Array.isArray(labels) ? labels.map((x) => String(x).slice(0, 24)).slice(0, 40) : [];
  if (!lbls.length) {
    const n = Array.isArray(sets[0]?.values) ? sets[0].values.length : 0;
    if (!n) throw new Error('labels 为空，且 datasets 里也没有 values 可用');
    lbls = Array.from({ length: n }, (_, i) => String(i + 1));
  }

  mkdirSync(GEN_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const outPath = join(GEN_DIR, `chart-${ctype}-${stamp}.png`);
  const payload = {
    chartType: ctype,
    title: String(title || '').slice(0, 60),
    labels: lbls,
    datasets: sets.slice(0, 6),
    style: ['academic', 'transparent'].includes(String(style)) ? String(style) : 'academic',
    unit: String(unit || '').slice(0, 8),
    output: outPath,
  };
  if (Number(width) > 3) payload.width = Number(width);
  if (Number(height) > 2) payload.height = Number(height);

  const reqPath = join(GEN_DIR, `chart-req-${stamp}.json`);
  writeFileSync(reqPath, JSON.stringify(payload), 'utf8');
  try {
    const { stdout } = await execFileAsync(PY, [CHART_PY, '--spec', reqPath], {
      timeout: 90000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const j = JSON.parse(line);
    if (!j.ok) throw new Error(j.error || '图表生成失败');
    const buf = readFileSync(outPath);
    if (key) {
      await sendImageTo(key, buf);
      try { unlinkSync(outPath); } catch { /* ignore */ }
      return `已生成 ${ctype} 图「${String(title || '').slice(0, 20)}」(${j.w}x${j.h}, ${Math.round(buf.length / 1024)}KB, ${payload.style}) 并发送到 ${key}`;
    }
    return `图表已生成：${outPath}（${ctype}｜${payload.style}｜${j.w}x${j.h}｜${Math.round(buf.length / 1024)}KB）`;
  } finally {
    try { unlinkSync(reqPath); } catch { /* ignore */ }
  }
}

// ── [工具] Word/Excel 模板无损填表 office_template_filler ──────────────────
const OFFICE_FILL_PY = `${ROOT}/office_fill.py`;

async function officeTemplateFiller({ mode = 'inspect', path: localPath, groupId, fileId, fileHash, userId, busid, mappings, outputName, key } = {}) {
  const act = String(mode || 'inspect').toLowerCase();
  if (!['inspect', 'fill'].includes(act)) throw new Error('mode 只支持 inspect / fill');

  mkdirSync(DOC_DIR, { recursive: true });
  let srcPath = String(localPath || '').trim();

  // 没给本地路径就按 QQ 文件下载
  if (!srcPath) {
    if (!fileId) throw new Error('需要 path，或 groupId/userId + fileId 走 QQ 文件');
    const url = await resolveQqFileUrl({ groupId, fileId, fileHash, userId, busid });
    const res = await fetch(url, {
      headers: { 'user-agent': UA, ...(url.includes('qq.com') ? { referer: 'https://qun.qq.com/' } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`模板下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let name = decodeURIComponent((url.split('?')[0].split('/').pop() || 'template'));
    const cd = res.headers.get('content-disposition') ?? '';
    const cdm = /filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i.exec(cd);
    if (cdm) name = decodeURIComponent(cdm[1]);
    if (!/\.(docx|xlsx|xlsm)$/i.test(name)) name += '.docx';
    srcPath = join(DOC_DIR, `${Date.now()}-${name}`);
    writeFileSync(srcPath, buf);
  }
  if (!existsSync(srcPath)) throw new Error(`文件不存在：${srcPath}`);

  const spec = { mode: act, path: srcPath };
  if (act === 'fill') {
    if (!mappings || typeof mappings !== 'object' || !Object.keys(mappings).length) {
      throw new Error('mode=fill 需要 mappings，例如 {"name":"张三","Sheet1!B3":90}');
    }
    const ext = (/\.xlsx$/i.test(srcPath) ? '.xlsx' : '.docx');
    const base = outputName ? String(outputName).replace(/[\\/:*?"<>|]/g, '_') : `filled-${Date.now()}${ext}`;
    spec.mappings = mappings;
    spec.output = join(DOC_DIR, base.endsWith(ext) ? base : base + ext);
  }

  const reqPath = join(DOC_DIR, `office-req-${Date.now()}-${Math.random().toString(36).slice(2, 5)}.json`);
  writeFileSync(reqPath, JSON.stringify(spec), 'utf8');
  try {
    const { stdout } = await execFileAsync(PY, [OFFICE_FILL_PY, '--spec', reqPath], {
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const j = JSON.parse(String(stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    if (!j.ok) throw new Error(j.error || '模板处理失败');

    if (act === 'inspect') {
      const lines = [`【模板结构】${j.kind}`];
      if (j.placeholders?.length) lines.push(`占位符：${j.placeholders.join('、')}`);
      else lines.push('占位符：未发现 {{...}}，可按坐标填（Excel 用「Sheet!B3」）');
      if (j.kind === 'xlsx') {
        for (const sh of (j.sheets || []).slice(0, 4)) {
          lines.push(`· 工作表「${sh.name}」${sh.rows}行×${sh.cols}列｜表头：${(sh.head?.[0] || []).filter(Boolean).join(' / ') || '空'}`);
        }
      } else {
        lines.push(`段落 ${j.paragraphCount} 段，表格 ${(j.tables || []).length} 个`);
        for (const tb of (j.tables || []).slice(0, 3)) {
          lines.push(`· 表${tb.index}: ${tb.rows}行×${tb.cols}列｜首行：${(tb.head?.[0] || []).filter(Boolean).join(' / ')}`);
        }
      }
      lines.push(`（源文件：${srcPath}）`);
      return lines.join('\n');
    }

    if (key) {
      const { kind: k2, target } = parseKey(key);
      await sendFileToChat({ kind: k2, target, buffer: readFileSync(j.path), name: basename(j.path) });
      return `模板已填好并发送到 ${key}：${basename(j.path)}（替换 ${j.filled} 处，${Math.round(j.bytes / 1024)}KB）`;
    }
    return `模板已填好：${j.path}（替换 ${j.filled} 处，${Math.round(j.bytes / 1024)}KB）`;
  } finally {
    try { unlinkSync(reqPath); } catch { /* ignore */ }
  }
}

// ── [工具] 协议文件与图片中转解析 qq_media_resolver ──────────────────────────
const QQ_FILE_EXTS = ['.txt', '.md', '.csv', '.json', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.zip', '.rar', '.7z', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.mp4', '.wav', '.m4a'];

function guessExtFromName(name) {
  const m = /(\.[a-z0-9]{1,6})$/i.exec(String(name || '').split('?')[0]);
  return m ? m[1].toLowerCase() : '';
}

async function qqMediaResolver({ action = 'resolve_image_url', messageId, imageIndex = 0, fileId, groupId, userId, fileHash, busid, url, path: localPath } = {}) {
  const act = String(action || 'resolve_image_url').toLowerCase();

  if (act === 'resolve_image_url') {
    if (url) return `图片公网地址：${String(url)}`;
    if (messageId !== undefined && messageId !== null && String(messageId).trim() !== '') {
      const data = await onebotCall('get_msg', { message_id: Number(messageId) });
      const msg = data?.message ?? data?.messages ?? data;
      const segs = Array.isArray(msg) ? msg : (Array.isArray(msg?.message) ? msg.message : []);
      const images = segs.filter((sg) => sg?.type === 'image');
      if (!images.length) throw new Error('这条消息里没有图片段');
      const pick = images[Math.max(0, Math.min(images.length - 1, Number(imageIndex) || 0))];
      const u = pick?.data?.url || pick?.data?.file || '';
      if (!u) throw new Error('图片段里没有可用地址');
      if (!/^https?:\/\//i.test(u)) throw new Error('协议端只给了本地文件名，拿不到公网地址');
      return `图片公网地址：${u}`;
    }
    if (localPath) {
      if (!existsSync(localPath)) throw new Error(`本地文件不存在：${localPath}`);
      // 本地文件对外不可达：明确说清楚，别让调用方拿着本地路径去请求外部 API
      return `这个文件在本地（${localPath}），外部接口访问不到。需要公网地址的话请用 messageId 从 QQ 消息里取。`;
    }
    throw new Error('需要 messageId（从消息取图片），或直接给 url');
  }

  if (act === 'resolve_file') {
    if (localPath && existsSync(localPath)) {
      const st = statSync(localPath);
      return `文件已就绪：${localPath}（${basename(localPath)}，${Math.round(st.size / 1024)}KB，后缀 ${guessExtFromName(localPath) || '无'}）`;
    }
    if (!fileId) throw new Error('需要 fileId（配合 groupId 或 userId）');
    const srcUrl = url || await resolveQqFileUrl({ groupId, fileId, fileHash, userId, busid });
    const res = await fetch(srcUrl, {
      headers: { 'user-agent': UA, ...(srcUrl.includes('qq.com') ? { referer: 'https://qun.qq.com/' } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    let name = decodeURIComponent((String(srcUrl).split('?')[0].split('/').pop() || 'file'));
    const cd = res.headers.get('content-disposition') ?? '';
    const cdm = /filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i.exec(cd);
    if (cdm) name = decodeURIComponent(cdm[1]);
    if (!guessExtFromName(name)) {
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      const byType = {
        'text/plain': '.txt', 'application/pdf': '.pdf', 'application/json': '.json',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
        'application/zip': '.zip', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
      };
      for (const [k, ext] of Object.entries(byType)) {
        if (ct.includes(k)) { name += ext; break; }
      }
      if (!guessExtFromName(name)) name += '.bin';
    }
    mkdirSync(DOC_DIR, { recursive: true });
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const dest = join(DOC_DIR, `qqfile-${Date.now()}-${safe}`);
    writeFileSync(dest, buf);
    return `文件已补全并落地：${dest}（${safe}，${Math.round(buf.length / 1024)}KB）\n下一步直接把这个 path 传给 read_file / office_template_filler 即可。`;
  }

  throw new Error('action 只支持 resolve_file / resolve_image_url');
}

// ── [工具] 课表与考试 DDL 管家 academic_ddl_tracker ─────────────────────────
const ACADEMIC_FILE = `${ROOT}/academic.json`;
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const SECTION_TIME = {
  '1-2': '08:00-09:40', '3-4': '10:00-11:40', '5-6': '14:00-15:40',
  '7-8': '16:00-17:40', '9-10': '19:00-20:40', '11-12': '20:50-22:30',
};

function loadAcademic() {
  try {
    const d = JSON.parse(readFileSync(ACADEMIC_FILE, 'utf8'));
    return {
      courses: Array.isArray(d?.courses) ? d.courses : [],
      ddls: Array.isArray(d?.ddls) ? d.ddls : [],
    };
  } catch {
    return { courses: [], ddls: [] };
  }
}

function saveAcademic(data) {
  writeFileSync(ACADEMIC_FILE, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function todayCst() {
  // 固定 UTC+8，避免服务器时区影响
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate(), w: now.getUTCDay() };
}

function dayOffset(base, add) {
  const t = new Date(Date.UTC(base.y, base.m - 1, base.d + add));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), w: t.getUTCDay() };
}

function fmtDay(x) {
  return `${x.m}月${x.d}日 ${WEEKDAY_CN[x.w]}`;
}

function daysUntil(dateStr) {
  const due = Date.parse(String(dateStr).replace(' ', 'T'));
  if (!Number.isFinite(due)) return null;
  const nowCst = new Date(Date.now() + 8 * 3600 * 1000);
  const todayUtc = Date.UTC(nowCst.getUTCFullYear(), nowCst.getUTCMonth(), nowCst.getUTCDate());
  const dueCst = new Date(due + 8 * 3600 * 1000);
  const dueUtc = Date.UTC(dueCst.getUTCFullYear(), dueCst.getUTCMonth(), dueCst.getUTCDate());
  return Math.round((dueUtc - todayUtc) / 86400000);
}

function courseLines(list, day) {
  const items = list.filter((c) => Number(c.weekday) === day.w);
  if (!items.length) return [`${fmtDay(day)}：没课，可以睡到自然醒喵～`];
  return items
    .sort((a, b) => String(a.sections || '').localeCompare(String(b.sections || '')))
    .map((c) => {
      const tm = SECTION_TIME[String(c.sections || '')] || '';
      return `${fmtDay(day)} ${c.sections ? c.sections + '节' : ''}${tm ? ` ${tm}` : ''}｜${c.name}${c.room ? ` @ ${c.room}` : ''}${c.teacher ? `（${c.teacher}）` : ''}`;
    });
}

async function academicDdlTracker({ action = 'list', kind = 'ddl', id, name, teacher, room, weekday, sections, weeks, title, course, due, type, courses, ddls, range = 'today', weekdayQuery, limit = 12 } = {}) {
  const act = String(action || 'list').toLowerCase();
  const data = loadAcademic();

  if (act === 'add') {
    const bucket = String(kind || 'ddl').toLowerCase() === 'course' ? 'courses' : 'ddls';
    const nid = `${bucket === 'courses' ? 'c' : 'd'}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
    if (bucket === 'courses') {
      if (!name) throw new Error('加课程需要 name');
      data.courses.push({
        id: nid, name: String(name).slice(0, 40), teacher: String(teacher || '').slice(0, 20),
        room: String(room || '').slice(0, 30), weekday: Number(weekday) || 1,
        sections: String(sections || '').slice(0, 10), weeks: String(weeks || '').slice(0, 20),
      });
      saveAcademic(data);
      return `已记下课程 [${nid}]：${name}（周${Number(weekday) || 1} ${sections || ''}${room ? ' @' + room : ''}）`;
    }
    if (!title || !due) throw new Error('加 DDL 需要 title 和 due（如 2026-12-15 或 12-15 09:00）');
    data.ddls.push({
      id: nid, title: String(title).slice(0, 60), course: String(course || '').slice(0, 30),
      due: String(due).replace(' ', 'T'), type: ['exam', 'homework', 'project', 'other'].includes(String(type)) ? String(type) : 'homework',
    });
    saveAcademic(data);
    const left = daysUntil(due);
    return `已记下 DDL [${nid}]：${title}${left !== null ? `（还有 ${left} 天）` : ''}`;
  }

  if (act === 'import_from_file' || act === 'import') {
    let added = 0;
    if (Array.isArray(courses)) {
      for (const c of courses.slice(0, 200)) {
        if (!c?.name) continue;
        data.courses.push({
          id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
          name: String(c.name).slice(0, 40), teacher: String(c.teacher || '').slice(0, 20),
          room: String(c.room || '').slice(0, 30), weekday: Number(c.weekday) || 1,
          sections: String(c.sections || '').slice(0, 10), weeks: String(c.weeks || '').slice(0, 20),
        });
        added += 1;
      }
    }
    if (Array.isArray(ddls)) {
      for (const d of ddls.slice(0, 200)) {
        if (!d?.title || !d?.due) continue;
        data.ddls.push({
          id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
          title: String(d.title).slice(0, 60), course: String(d.course || '').slice(0, 30),
          due: String(d.due).replace(' ', 'T'),
          type: ['exam', 'homework', 'project', 'other'].includes(String(d.type)) ? String(d.type) : 'homework',
        });
        added += 1;
      }
    }
    saveAcademic(data);
    return added ? `已批量导入 ${added} 条（课程 ${data.courses.length} 门 / DDL ${data.ddls.length} 条）` : '没收到可导入的课程或 DDL';
  }

  if (act === 'remove') {
    const rid = String(id || '').trim();
    if (!rid) throw new Error('remove 需要 id');
    const before = data.courses.length + data.ddls.length;
    data.courses = data.courses.filter((c) => c.id !== rid);
    data.ddls = data.ddls.filter((d) => d.id !== rid);
    saveAcademic(data);
    return (data.courses.length + data.ddls.length) < before ? `已删除 ${rid}` : `找不到 ${rid}`;
  }

  if (act === 'query_schedule' || act === 'query') {
    const today = todayCst();
    const out = [];
    const r = String(range || 'today').toLowerCase();
    // weekdayQuery 优先：否则 range 的默认值 'today' 会把它吃掉
    if (weekdayQuery !== undefined && weekdayQuery !== null && weekdayQuery !== '') {
      const wd = ((Number(weekdayQuery) % 7) + 7) % 7;
      out.push(...courseLines(data.courses, { ...today, w: wd }));
    } else if (r === 'tomorrow') {
      out.push(...courseLines(data.courses, dayOffset(today, 1)));
    } else if (r === 'week') {
      for (let i = 0; i < 7; i += 1) {
        const day = dayOffset(today, i);
        const lines = courseLines(data.courses, day);
        if (!lines[0]?.includes('没课')) out.push(...lines);
      }
      if (!out.length) out.push('这周都没课，爽喵～');
    } else if (/^[1-7]$/.test(r)) {
      out.push(...courseLines(data.courses, { ...today, w: Number(r) % 7 }));
    } else {
      out.push(...courseLines(data.courses, today));
    }

    const near = data.ddls
      .map((d) => ({ ...d, left: daysUntil(d.due) }))
      .filter((d) => d.left !== null && d.left >= -1)
      .sort((a, b) => a.left - b.left)
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
    if (near.length) {
      out.push('—— 最近的 DDL ——');
      for (const d of near) {
        const tag = d.left < 0 ? '已过' : d.left === 0 ? '今天截止' : d.left === 1 ? '明天截止' : `还有 ${d.left} 天`;
        out.push(`${d.title}${d.course ? `（${d.course}）` : ''}：${tag}`);
      }
    }
    return out.join('\n') || '课表和 DDL 都还是空的，先让自己记几条吧～';
  }

  // list
  const out = [];
  if (data.courses.length) {
    out.push(`—— 课表（${data.courses.length} 门）——`);
    for (const c of data.courses.slice(0, 30)) {
      out.push(`[${c.id}] ${c.name}｜${WEEKDAY_CN[Number(c.weekday) || 0]} ${c.sections || ''}${c.room ? ' @' + c.room : ''}`);
    }
  }
  if (data.ddls.length) {
    out.push(`—— DDL（${data.ddls.length} 条）——`);
    for (const d of data.ddls.slice(0, 30)) {
      const left = daysUntil(d.due);
      out.push(`[${d.id}] ${d.title}｜${String(d.due).replace('T', ' ')}${left !== null ? `（${left >= 0 ? '还有 ' + left + ' 天' : '已过' }）` : ''}`);
    }
  }
  return out.join('\n') || '课表和 DDL 都还是空的。';
}

// ── [工具] 电竞赛程与比分雷达 esports_match_radar ───────────────────────────
const ESPORTS_SUBS_FILE = `${ROOT}/esports_subs.json`;
const ESPORTS_GAMES = { lol: '英雄联盟', ow: '守望先锋', dota2: 'DOTA2', csgo: 'CS2', val: '无畏契约', kog: '王者荣耀' };

function loadEsportsSubs() {
  try {
    const d = JSON.parse(readFileSync(ESPORTS_SUBS_FILE, 'utf8'));
    return { subs: Array.isArray(d?.subs) ? d.subs : [] };
  } catch {
    return { subs: [] };
  }
}

function saveEsportsSubs(data) {
  writeFileSync(ESPORTS_SUBS_FILE, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

async function esportsMatchRadar({ action = 'list_subs', game = 'lol', teamOrLeague, team, league, limit = 4 } = {}) {
  const act = String(action || 'list_subs').toLowerCase();
  const data = loadEsportsSubs();
  const gameKey = String(game || 'lol').toLowerCase();
  const gameCn = ESPORTS_GAMES[gameKey] || String(game || '电竞');
  const target = String(teamOrLeague || team || league || '').trim();

  if (act === 'subscribe' || act === 'unsubscribe') {
    const t = target;
    if (!t) throw new Error('subscribe/unsubscribe 需要 teamOrLeague（战队或赛事名，如 WBG / LPL）');
    if (act === 'subscribe') {
      const dup = data.subs.find((x) => x.name === t && x.game === gameKey);
      if (dup) return `已经在关注 ${t}（${gameCn}）了`;
      data.subs.push({ name: t, game: gameKey, at: Date.now() });
      saveEsportsSubs(data);
      return `已关注 ${t}（${gameCn}），之后可以随时问「${t} 最近赛程」`;
    }
    const before = data.subs.length;
    data.subs = data.subs.filter((x) => !(x.name === t && x.game === gameKey));
    saveEsportsSubs(data);
    return data.subs.length < before ? `已取消关注 ${t}` : `没找到 ${t} 的关注记录`;
  }

  if (act === 'list_subs') {
    if (!data.subs.length) return '还没关注任何战队或赛事，说「关注 WBG」就行';
    return '关注的战队/赛事：' + data.subs.map((x) => `${x.name}（${ESPORTS_GAMES[x.game] || x.game}）`).join('、');
  }

  if (act === 'query_matches' || act === 'query') {
    const q = target
      ? `${target} ${gameCn} 赛程 比分`
      : `今日 ${gameCn} 赛程 比分`;
    // 用现有搜索链兜底（exa → tavily → 360 → sogou → bing）
    const raw = await webSearch({ query: q, limit: Math.max(2, Math.min(6, Number(limit) || 4)) });
    const compact = String(raw || '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 18)
      .join('\n')
      .slice(0, 1600);
    return `【${target || gameCn + ' 今日赛程'}】搜索结果（未经编辑，需你消化）：
${compact}

提示：只挑 1~2 个最有关的赛程/比分说，用吃瓜观赛的活泼口吻发 1~2 条短气泡；绝不复制整篇战报、不列长表格。`;
  }

  throw new Error('action 只支持 subscribe / unsubscribe / list_subs / query_matches');
}

// ── AI 画图（Pollinations，免 key）────────────────────────────────────────
// 实测：model=flux 可用（约 2s/张），不带 model 会 402。
const GEN_DIR = `${ROOT}/gen`;
let lastGenAt = 0;

// 生成是慢活（免费额度每 45 秒 1 张，且会 402/503），所以：
//   · 给了 key → 立刻返回「开始画了」，后台循环重试，画好直接发到会话
//   · 没给 key → 同步试一次，成功返回本地路径
// 供应商配置：imagegen.json
//   {"provider":"zhipu","apiKey":"…"}       智谱 CogView-3-Flash（免费，中文提示词也行）
//   {"provider":"siliconflow","apiKey":"…"} SiliconFlow Kolors
//   不配 → 回落到 Pollinations flux（免 key，每 45 秒 1 张）
const GEN_CONF = `${ROOT}/imagegen.json`;

function genConfig() {
  try { return JSON.parse(readFileSync(GEN_CONF, 'utf8')); } catch { return {}; }
}

function enhancePrompt(text) {
  const suffix = 'masterpiece, best quality, highly detailed, sharp focus, soft lighting';
  return /masterpiece|best quality|highly detailed/i.test(text) ? text : `${text}, ${suffix}`;
}

async function genPollinations(text, w, h, mdl) {
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(text)}`
    + `?width=${w}&height=${h}&model=${encodeURIComponent(mdl)}&nologo=true&seed=${seed}`;
  const conf2 = genConfig();
  const opts = { headers: { 'user-agent': UA, accept: 'image/*' }, signal: AbortSignal.timeout(150000) };
  let res;
  try {
    res = await genFetch(url, opts, conf2.proxy || '');
  } catch (error) {
    if (conf2.proxy) {
      log(`[gen] 代理不可用（${error?.message ?? error}），回落直连`);
      res = await fetch(url, opts);
    } else {
      throw error;
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const isImg = (buf[0] === 0xff && buf[1] === 0xd8) || buf.toString('ascii', 1, 4) === 'PNG';
  if (!isImg) {
    const err = new Error(`HTTP ${res.status} ${buf.toString('utf8', 0, 60).replace(/\s+/g, ' ')}`);
    err.retryable = true;
    throw err;
  }
  if (buf.length < 3000) throw new Error('返回内容太小，不像图片');
  return buf;
}

// 智谱 CogView：返回 URL，要再下一次
async function genZhipu(text, w, h, apiKey) {
  const size = w === h ? `${w}x${h}` : '1024x1024';
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt: text, size }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`智谱 HTTP ${res.status} ${JSON.stringify(j).slice(0, 120)}`);
  const u = j?.data?.[0]?.url;
  if (!u) throw new Error(`智谱没返回图片：${JSON.stringify(j).slice(0, 120)}`);
  const img = await fetch(u, { signal: AbortSignal.timeout(60000) });
  return Buffer.from(await img.arrayBuffer());
}

async function genSiliconFlow(text, w, h, apiKey) {
  const res = await fetch('https://api.siliconflow.cn/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'Kwai-Kolors/Kolors', prompt: text, image_size: `${w}x${h}`, batch_size: 1 }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SiliconFlow HTTP ${res.status} ${JSON.stringify(j).slice(0, 120)}`);
  const u = j?.images?.[0]?.url ?? j?.data?.[0]?.url;
  if (!u) throw new Error(`SiliconFlow 没返回图片`);
  const img = await fetch(u, { signal: AbortSignal.timeout(60000) });
  return Buffer.from(await img.arrayBuffer());
}

// 图像生成用的 fetch：配置里给了 proxy（如 http://127.0.0.1:19081）就走代理，
// 这样服务器可以借本机 VPN 的出口访问 OpenAI / Pollinations。
let genProxyAgent = null;
function genFetch(url, opts = {}, proxyUrl = '') {
  if (!proxyUrl) return fetch(url, opts);
  if (!genProxyAgent) genProxyAgent = new ProxyAgent(proxyUrl);
  return proxyFetch(url, { ...opts, dispatcher: genProxyAgent });
}

// OpenAI 兼容（官方 / 中转站都行）：POST {baseUrl}/v1/images/generations
async function genOpenAI(text, w, h, conf) {
  const baseUrl = String(conf.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const model = String(conf.model || 'gpt-image-1');
  const res = await genFetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.apiKey}` },
    body: JSON.stringify({ model, prompt: text, size: `${w}x${h}`, n: 1 }),
    signal: AbortSignal.timeout(180000),
  }, conf.proxy || '');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status} ${JSON.stringify(j).slice(0, 140)}`);
  const item = j?.data?.[0] ?? {};
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error(`OpenAI 没返回图片：${JSON.stringify(j).slice(0, 120)}`);
}


// 即梦 AI（字节 · Seedream）：走火山引擎 Ark 的 OpenAI 兼容接口
//   文档：https://www.volcengine.com/docs/82379  控制台开通后用 Bearer API Key
async function genArk(text, w, h, conf) {
  const baseUrl = String(conf.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const model = String(conf.model || 'doubao-seedream-3-0-t2i-250415');
  // Ark 只吃固定尺寸档位，挑最接近的
  const allow = [[1024, 1024], [864, 1152], [1152, 864], [1280, 720], [720, 1280], [1024, 768], [768, 1024]];
  const ratio = w / h;
  let best = allow[0];
  let bestDiff = Infinity;
  for (const [aw, ah] of allow) {
    const d = Math.abs((aw / ah) - ratio);
    if (d < bestDiff) { bestDiff = d; best = [aw, ah]; }
  }
  const size = `${best[0]}x${best[1]}`;
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.apiKey}` },
    body: JSON.stringify({ model, prompt: text, size, response_format: 'url', n: 1 }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`即梦 HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`);
  const item = j?.data?.[0] ?? {};
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error(`即梦没返回图片：${JSON.stringify(j).slice(0, 140)}`);
}

async function genOnce(text, w, h, mdl) {
  const conf = genConfig();
  if (conf.provider === 'ark' && conf.apiKey) {
    return saveGen(await genArk(enhancePrompt(text), w, h, conf), 'ark');
  }
  if (conf.provider === 'openai' && conf.apiKey) {
    return saveGen(await genOpenAI(enhancePrompt(text), w, h, conf), 'oa');
  }
  if (conf.provider === 'zhipu' && conf.apiKey) return genZhipuBuffered(text, w, h, conf.apiKey);
  if (conf.provider === 'siliconflow' && conf.apiKey) return genSiliconFlowBuffered(text, w, h, conf.apiKey);
  return genPollinationsBuffered(text, w, h, mdl);
}

function saveGen(buf, seedTag) {
  const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : 'png';
  mkdirSync(GEN_DIR, { recursive: true });
  const file = join(GEN_DIR, `gen-${Date.now()}-${seedTag}.${ext}`);
  writeFileSync(file, buf);
  return { file, buf, bytes: buf.length };
}

async function genZhipuBuffered(text, w, h, key) {
  return saveGen(await genZhipu(enhancePrompt(text), w, h, key), 'zp');
}
async function genSiliconFlowBuffered(text, w, h, key) {
  return saveGen(await genSiliconFlow(enhancePrompt(text), w, h, key), 'sf');
}
async function genPollinationsBuffered(text, w, h, mdl) {
  return saveGen(await genPollinations(enhancePrompt(text), w, h, mdl), Math.floor(Math.random() * 1e9));
}

// 服务器侧下载图片并校验（避免把 URL 丢给 OneBot 去拉：容器里常超时，且失败无声）
async function fetchImageBuffer(url, timeout = 70000) {
  const res = await fetch(String(url), {
    headers: { 'user-agent': UA, referer: 'https://www.pixiv.net/', accept: 'image/*' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isImg = (buf[0] === 0xff && buf[1] === 0xd8) || buf.toString('ascii', 1, 4) === 'PNG'
    || buf.toString('ascii', 0, 4) === 'RIFF';
  if (!isImg) throw new Error('不是图片');
  if (buf.length < 2000) throw new Error('图太小');
  return buf;
}

async function sendImageTo(key, buf) {
  const m = /^(group|private):(\d+)$/.exec(String(key).trim());
  if (!m) throw new Error('key 格式 group:群号 或 private:QQ号');
  const [, kind, target] = m;
  const payload = kind === 'group'
    ? { group_id: Number(target), message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }] }
    : { user_id: Number(target), message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }] };
  await onebotCall(kind === 'group' ? 'send_group_msg' : 'send_private_msg', payload);
}


// 出图日配额：每天最多 N 张（默认 5），跨天自动清零。
const GEN_QUOTA = `${ROOT}/imagegen-quota.json`;
const GEN_DAILY_DEFAULT = 5;

function quotaLoad() {
  const today = new Date().toISOString().slice(0, 10);
  let q = { date: today, count: 0 };
  try {
    const j = JSON.parse(readFileSync(GEN_QUOTA, 'utf8'));
    if (j?.date === today) q = { date: today, count: Number(j.count) || 0 };
  } catch { /* 首次或损坏，按 0 起算 */ }
  return q;
}

function quotaSave(q) {
  try { writeFileSync(GEN_QUOTA, JSON.stringify(q)); } catch { /* 忽略写失败 */ }
}

function quotaLimit() {
  const conf = genConfig();
  const n = Number(conf.dailyLimit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : GEN_DAILY_DEFAULT;
}

/** 返回 null 表示还有额度，否则返回提示文案 */
function quotaBlocked() {
  const q = quotaLoad();
  const limit = quotaLimit();
  if (q.count >= limit) {
    return `今天的出图额度用完了（${q.count}/${limit}），明天再来吧`;
  }
  return null;
}

function quotaBump() {
  const q = quotaLoad();
  q.count += 1;
  quotaSave(q);
  return q;
}

async function imageGenerate({ prompt, key, width = 1024, height = 1024, model = 'flux', count = 1 } = {}) {
  const text = clip(prompt, 200);
  if (!text) throw new Error('prompt 不能为空');
  const w = Math.max(256, Math.min(1024, Number(width) || 1024));
  const h = Math.max(256, Math.min(1024, Number(height) || 1024));
  const n = 1; // Gemini修改：每次画图最多发 1 张，防止连发刷屏
  const conf = genConfig();
  const provider = ['ark', 'openai', 'zhipu', 'siliconflow'].includes(conf.provider) && conf.apiKey ? conf.provider : 'pollinations';

  // 日配额：所有 provider 共用，避免刷图烧钱或占资源
  const blocked = quotaBlocked();
  if (blocked) return blocked;
  if (n > quotaLimit() - quotaLoad().count) {
    return `今天只剩 ${quotaLimit() - quotaLoad().count} 张额度，一次最多画 ${Math.max(0, quotaLimit() - quotaLoad().count)} 张`;
  }

  if (!key) {
    const items = [];
    for (let i = 0; i < n; i += 1) {
      if (i > 0) await new Promise((x) => setTimeout(x, provider === 'pollinations' ? 46000 : 2000));
      items.push(await genOnce(text, w, h, model));
      quotaBump();
    }
    return `画好了（${provider}）：${clip(text, 40)}｜${w}×${h}｜${n} 张｜今日 ${quotaLoad().count}/${quotaLimit()}\n` + items.map((s) => `  ${s.file}（${Math.round(s.bytes / 1024)}KB）`).join('\n');
  }

  void (async () => {
    for (let i = 0; i < n; i += 1) {
      let ok = false;
      for (let attempt = 0; attempt < (provider === 'pollinations' ? 2 : 2) && !ok; attempt += 1) { // Gemini修改：减少后台重试，避免喊停后仍继续出图
        try {
          const r = await genOnce(text, w, h, model);
          quotaBump();
          await sendImageTo(key, r.buf);
          log(`[gen] ${provider} ${key} 第 ${i + 1} 张已发送（${Math.round(r.bytes / 1024)}KB，第 ${attempt + 1} 次）`);
          ok = true;
        } catch (error) {
          const wait = provider === 'pollinations' ? 46000 : ((provider === 'openai' || provider === 'ark') ? 4000 : 5000);
          log(`[gen] ${provider} ${key} 失败（${error?.message ?? error}），${Math.round(wait / 1000)}s 后重试`);
          await new Promise((r2) => setTimeout(r2, wait));
        }
      }
      if (!ok) log(`[gen] ${provider} ${key} 第 ${i + 1} 张最终失败`);
    }
  })().catch((e) => log('[gen] 后台异常：', e?.message ?? e));

  return `开始画了（${provider}）：${clip(text, 40)}｜${w}×${h}｜${n} 张｜今日 ${quotaLoad().count}/${quotaLimit()}，画好直接发到 ${key}。`;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────
// ── 合并工具的实现（把旧工具收成入口）──────────────────
async function hotTopic({ kind = 'hot', query, source, acgKind, limit = 10 } = {}) {
  const k = String(kind || 'hot').toLowerCase();
  if (k === 'meme') {
    if (!query) throw new Error('kind=meme 要给 query');
    return memeLookup({ query, limit: Math.min(10, Number(limit) || 5) });
  }
  if (k === 'acg') {
    return acgLookup({ kind: acgKind || (query ? 'search' : 'rank'), query, limit: Math.min(20, Number(limit) || 8) });
  }
  return webHotlist({ source: source || 'baidu', limit: Math.min(30, Number(limit) || 10) });
}

const READ_MEDIA_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus', '.aiff', '.amr',
  '.mp4', '.avi', '.rm', '.rmvb', '.mkv', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.3gp', '.mid', '.midi'];

async function readFile({ url, path: localPath, groupId, userId, fileId, fileHash, busid,
                         maxChars = 20000, maxSeconds = 1800 } = {}) {
  // 按扩展名判断走文档还是音视频；判断不出来就先用 doc_read 试，失败再试 media_read
  const probeName = String(localPath || url || '').trim();
  const ext = probeName ? docExt(probeName.split('?')[0]) : '';
  if (READ_MEDIA_EXTS.includes(ext)) {
    return mediaRead({ url, path: localPath, maxSeconds });
  }
  if (ext) {
    return docRead({ url, path: localPath, groupId, userId, fileId, fileHash, busid, maxChars });
  }
  try {
    return await docRead({ url, path: localPath, groupId, userId, fileId, fileHash, busid, maxChars });
  } catch (e) {
    try {
      return await mediaRead({ url, path: localPath, maxSeconds });
    } catch {
      throw e;
    }
  }
}

async function memoryRead({ mode = 'tree', path: rel, category, maxLines = 120 } = {}) {
  if (String(mode).toLowerCase() === 'open') {
    if (!rel) throw new Error('mode=open 要给 path');
    return memoryOpen({ path: rel, maxLines });
  }
  return memoryTree({ category });
}

async function memoryEdit({ mode = 'patch', path: rel, old, replacement, toCategory, rename } = {}) {
  if (String(mode).toLowerCase() === 'move') {
    if (!rel) throw new Error('mode=move 要给 path');
    return memoryMove({ path: rel, toCategory, rename });
  }
  if (!rel || !old) throw new Error('mode=patch 要给 path 和 old');
  if (typeof replacement !== 'string') throw new Error('mode=patch 要给 replacement');
  return memoryPatch({ path: rel, old, replacement });
}

async function biliDm({ action = 'list', talker, to, message, size = 20 } = {}) {
  const a = String(action).toLowerCase();
  if (a === 'read') {
    if (!talker) throw new Error('action=read 要给 talker（对方 uid）');
    return biliDmRead({ talker, size });
  }
  if (a === 'send') {
    if (!to || !message) throw new Error('action=send 要给 to 和 message');
    return biliDmSend({ to, message });
  }
  return biliDmList();
}

async function qqProfile({ action = 'get', nickname } = {}) {
  const a = String(action).toLowerCase();
  if (a === 'set') {
    if (!nickname) throw new Error('action=set 要给 nickname');
    return qqNameSet({ nickname });
  }
  return qqProfileGet();
}

const TOOLS = [
  {
    name: 'hot_topic',
    description: '热点与梗查询：kind=hot 看热榜（百度/头条/抖音/B站热搜）、kind=meme 查网络梗含义、kind=acg 看 B站番剧榜或搜番剧。被问「今天有什么热点」「这词什么意思」「最近有什么番」时用。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['hot', 'meme', 'acg'], description: 'hot=热搜，meme=梗百科，acg=番剧' },
        query: { type: 'string', description: 'kind=meme 查的词，或 kind=acg 搜的番剧名' },
        source: { type: 'string', description: 'kind=hot 的榜单来源：baidu/toutiao/douyin/bilibili' },
        acgKind: { type: 'string', enum: ['rank', 'search'], description: 'kind=acg 时：rank 榜单 / search 搜索' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '条数，默认 10' },
      },
    },
    run: hotTopic,
  },
  {
    name: 'read_file',
    description: '读文件内容（文档或音视频自动分辨）：pdf/xlsx/docx/csv/txt/md/json 抽文字；mp3/wav/mp4/avi/rm 转写成人话；mid 解析成乐谱信息。三种来源任选：url、path、或 QQ 文件（groupId+fileId / userId+fileId+fileHash）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文件直链' },
        path: { type: 'string', description: '服务器本地路径' },
        groupId: { type: 'integer', description: '群号（群文件）' },
        userId: { type: 'integer', description: 'QQ 号（私聊文件）' },
        fileId: { type: 'string', description: 'QQ 文件 file_id' },
        fileHash: { type: 'string', description: '私聊文件的 file_hash' },
        busid: { type: 'integer', description: '群文件 busid' },
        maxChars: { type: 'integer', description: '最多返回多少字符，默认 20000' },
        maxSeconds: { type: 'number', description: '音视频最多处理多少秒，默认 600' },
      },
    },
    run: readFile,
  },
  {
    name: 'memory_read',
    description: '看记忆库：mode=tree 看目录结构，mode=open 打开某个文件读内容（path 相对记忆库根目录）。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['tree', 'open'], description: 'tree 看结构 / open 读文件' },
        path: { type: 'string', description: 'mode=open 时的相对路径' },
        category: { type: 'string', description: 'mode=tree 时只看某个分类' },
        maxLines: { type: 'integer', description: '读多少行，默认 120' },
      },
    },
    run: memoryRead,
  },
  {
    name: 'memory_edit',
    description: '改记忆库：mode=patch 替换一段文字（path+old+replacement），mode=move 把文件挪分类或改名（path+toCategory/rename）。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['patch', 'move'], description: 'patch 改内容 / move 挪位置' },
        path: { type: 'string', description: '相对记忆库的路径' },
        old: { type: 'string', description: 'mode=patch 要替换的原文' },
        replacement: { type: 'string', description: 'mode=patch 替换成什么' },
        toCategory: { type: 'string', description: 'mode=move 目标分类' },
        rename: { type: 'string', description: 'mode=move 新文件名' },
      },
    },
    run: memoryEdit,
  },
  {
    name: 'bili_dm',
    description: 'B站私信：action=list 看会话列表、action=read 读某个会话（talker）、action=send 发私信（to+message）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'send'], description: '要做什么' },
        talker: { type: 'integer', description: 'action=read 的对方 uid' },
        to: { type: 'integer', description: 'action=send 的接收者 uid' },
        message: { type: 'string', description: 'action=send 的内容' },
        size: { type: 'integer', description: '读多少条，默认 20' },
      },
    },
    run: biliDm,
  },
  {
    name: 'qq_profile',
    description: '看或改自己的 QQ 资料：action=get 看昵称/头像，action=set 改昵称（nickname）。头像修改默认关闭。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get 查看 / set 改昵称' },
        nickname: { type: 'string', description: 'action=set 的新昵称' },
      },
    },
    run: qqProfile,
  },
  {
    name: 'gallery_collect',
    description: '从随机图 API（imgapi.lie.moe）抓 N 张图存进本地图库：自动校验图片类型、按 sha256 去重、缩到长边 1600 存储。返回新增的 id 和体积。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10, description: '抓几张，默认 5' },
      },
    },
    run: galleryCollect,
  },
  {
    name: 'gallery_list',
    description: '看图库里有什么：按时间倒序列出 id、体积、入库时间，支持分页。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '一页几条，默认 10' },
        offset: { type: 'integer', minimum: 0, description: '跳过几条，默认 0' },
      },
    },
    run: galleryList,
  },
  {
    name: 'gallery_send',
    description: '图库发图：说「发张图库里的」「从图库拿几张」时用，从本地图库挑。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        count: { type: 'integer', minimum: 1, maximum: 5, description: '随机发几张，默认 1' },
        id: { type: 'string', description: '可选：按 id 前缀指定某一张' },
      },
      required: ['key'],
    },
    run: gallerySend,
  },
  {
    name: 'office_template_filler',
    description: '[新增] 在 Word/Excel 原模板里无损填表：先 mode=inspect 摸清结构（占位符 {{...}}、表头、工作表），再 mode=fill 填好并保留原字体/边框/合并单元格/公式。文件可直接给 path，或用 groupId/fileId（群）或 userId/fileId/fileHash（私聊）从 QQ 取。Excel 的 mappings 支持 {"Sheet1!B3":90} 按坐标写，也支持占位符替换。传 key 直接把成品发回该会话。返回后必须消化成 1 句搭档口吻短气泡，禁止输出 JSON 原文。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['inspect', 'fill'], description: 'inspect=看结构 / fill=填好导出' },
        path: { type: 'string', description: '模板文件路径（.docx/.xlsx）' },
        groupId: { type: 'integer', description: '群文件来源：群号' },
        fileId: { type: 'string', description: 'QQ 文件 id' },
        fileHash: { type: 'string', description: '私聊文件的 file_hash' },
        userId: { type: 'integer', description: '私聊文件来源：对方 QQ' },
        busid: { type: 'integer', description: '群文件的 busid（可选）' },
        mappings: { type: 'object', description: 'fill 时的填充内容，键为占位符名或坐标如 "进度!C2"' },
        outputName: { type: 'string', description: '可选：输出文件名' },
        key: { type: 'string', description: '可选：成品发到这个会话（group:群号 / private:QQ号）' },
      },
      required: ['mode'],
    },
    run: officeTemplateFiller,
  },
  {
    name: 'qq_media_resolver',
    description: '[新增] 静默解析 QQ 文件与图片：action=resolve_file 拿真实文件名+后缀并下载到本地（返回可直接给 read_file 的路径）；action=resolve_image_url 从消息里取图片的公网 http(s) 地址（给 anime_search 等外部接口用）。绝对保密底层细节：严禁向群友提「缺少后缀 / 本地缓存路径 / 图床中转」这类技术词，认不出就俏皮说「这张图糊糊的自己没认出来呀～」。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['resolve_file', 'resolve_image_url'], description: 'resolve_file=补全文件 / resolve_image_url=取图片公网地址' },
        messageId: { type: ['number', 'string'], description: 'resolve_image_url 用：消息 id' },
        imageIndex: { type: 'integer', minimum: 0, maximum: 9, description: '第几张图，默认 0' },
        fileId: { type: 'string', description: 'resolve_file 用：QQ 文件 id' },
        groupId: { type: 'integer', description: '群号（群文件）' },
        userId: { type: 'integer', description: '对方 QQ（私聊文件）' },
        fileHash: { type: 'string', description: '私聊文件的 file_hash' },
        busid: { type: 'integer', description: '群文件 busid（可选）' },
        url: { type: 'string', description: '已知直链时可直接给' },
        path: { type: 'string', description: '已有本地路径时直接确认' },
      },
      required: ['action'],
    },
    run: qqMediaResolver,
  },
  {
    name: 'academic_ddl_tracker',
    description: '[新增] 课表与考试 DDL 管家：add/remove/list 增删查；import_from_file 批量导入（courses/ddls 数组）；query_schedule 按 range=today|tomorrow|week 或 weekdayQuery=1~7 查课程与教室，并列出最近 DDL 倒计时。被问「今天有啥课」「教室在哪」「还有几天考试」时秒查。回答用 1~2 条轻快短气泡（如「下午三四节有线性代数哦，在主楼 302，别跑错教室啦喵～」），严禁说教班主任腔。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list', 'import_from_file', 'query_schedule'], description: '默认 list' },
        kind: { type: 'string', enum: ['course', 'ddl'], description: 'add 时用：加课程还是加 DDL' },
        id: { type: 'string', description: 'remove 时的 id' },
        name: { type: 'string', description: '课程名' },
        teacher: { type: 'string' }, room: { type: 'string' },
        weekday: { type: 'integer', minimum: 0, maximum: 6, description: '0=周日 … 6=周六' },
        sections: { type: 'string', description: '节次，如 "3-4"' },
        weeks: { type: 'string', description: '周次，如 "1-16"' },
        title: { type: 'string', description: 'DDL 标题' },
        course: { type: 'string', description: 'DDL 所属课程' },
        due: { type: 'string', description: 'DDL 截止时间，如 2026-12-15 或 2026-12-15 09:00' },
        type: { type: 'string', enum: ['exam', 'homework', 'project', 'other'] },
        courses: { type: 'array', description: '批量导入的课程数组', items: { type: 'object' } },
        ddls: { type: 'array', description: '批量导入的 DDL 数组', items: { type: 'object' } },
        range: { type: 'string', enum: ['today', 'tomorrow', 'week'], description: 'query_schedule 的范围' },
        weekdayQuery: { type: 'integer', minimum: 0, maximum: 6, description: '查指定星期几' },
        limit: { type: 'integer', description: 'DDL 显示条数，默认 5' },
      },
      required: ['action'],
    },
    run: academicDdlTracker,
  },
  {
    name: 'esports_match_radar',
    description: '[新增] 电竞赛程与比分雷达：subscribe/unsubscribe/list_subs 管理关注的战队（如 WBG、BLG）与项目（lol/ow/dota2/csgo/val/kog）；query_matches 查近期赛程、实时状态与已结束比分。被问「WBG 最近打谁」「昨天谁赢了」时调用。结果必须消化成 1~2 条吃瓜观赛的活泼短气泡，绝不复制整篇战报或长表格。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['subscribe', 'unsubscribe', 'list_subs', 'query_matches'], description: '默认 list_subs' },
        game: { type: 'string', enum: ['lol', 'ow', 'dota2', 'csgo', 'val', 'kog'], description: '默认 lol' },
        teamOrLeague: { type: 'string', description: '战队或赛事名，如 WBG / BLG / LPL' },
        limit: { type: 'integer', minimum: 1, maximum: 6, description: '搜索条数，默认 4' },
      },
      required: ['action'],
    },
    run: esportsMatchRadar,
  },
  {
    name: 'file_make',
    description: '[Gemini修改] 现做文件并发到 QQ 会话：支持 csv / xlsx / txt / md / json / docx / pptx。做 PPT 时推荐传结构化 slides 数组或 --- 分页 Markdown + theme（6字段含 surface 卡片底色）+ takeaway 底部结论栏；支持版式：cover/section/grid-2x2/cols-3/split-visual/kpi-cards/timeline/table/chart/two-col/image-right/image-left/image-full/bullets。card/step 兼容 title/heading/label/step/name 与 body/desc/description/text/content/bullets；image/images 支持网页 HTTP(S) 原图直链自动下载嵌入；chart 支持 {type:"line"|"bar"|"barh", labels, values|series, unit, title} 自动绘制无锯齿数据图表。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        name: { type: 'string', description: '文件名（可不带扩展名，会按 format 补）' },
        format: { type: 'string', enum: ['txt', 'md', 'json', 'csv', 'xlsx', 'docx', 'pptx'], description: '默认 csv' },
        title: { type: 'string', description: 'docx/pptx 主标题' },
        subtitle: { type: 'string', description: 'docx/pptx 副标题' },
        slides: { type: 'array', description: 'pptx 结构化页面数组（每页含 layout/section/title/cards/cols/steps/table/chart/bullets/takeaway/image/images）' },
        theme: { type: 'object', description: 'pptx 主题：{bg,surface,primary,accent,text,muted}' },
        cover: { type: 'string', description: 'pptx 封面配图路径或 URL（严肃学术/商务勿用二次元图）' },
        rows: { type: 'array', items: { type: 'array' }, description: '二维数组，每行一个数组' },
        header: { type: 'array', items: { type: 'string' }, description: '可选：表头一行' },
        content: { type: 'string', description: '纯文本内容（txt/md/json），或 Markdown 格式的 docx/pptx 内容' },
        sheet: { type: 'string', description: 'xlsx 的工作表名，默认 Sheet1' },
      },
      required: ['key'],
    },
    run: fileMake,
  },
  {
    name: 'file_send',
    description: '把已有文件发到 QQ 会话：给 path（服务器本地）或 url（直链）。key 格式 group:群号 或 private:QQ号。上限 60MB。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        path: { type: 'string', description: '服务器本地路径' },
        url: { type: 'string', description: '文件直链' },
        name: { type: 'string', description: '可选：发送时显示的文件名' },
      },
      required: ['key'],
    },
    run: fileSend,
  },
  {
    name: 'qzone_post',
    description: '把一段文字（可带图）发到机器人自己的 QQ 空间说说。用于「写日记」「发条说说」。默认公开可见（ugcRight=1）。写完会自动存一份到 diary/。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文，最多 2000 字' },
        images: { type: 'array', items: { type: 'string' }, description: '可选：图片 URL 列表，会自动上传' },
        ugcRight: { type: 'integer', enum: [1, 4, 16, 64, 128], description: '1=公开（默认）4=好友 16/128=指定人（需 targetUins）' },
        targetUins: { type: 'array', items: { type: 'integer' }, description: 'ugcRight 为 16/128 时的指定 QQ 号' },
      },
      required: ['content'],
    },
    run: qzonePost,
  },
  {
    name: 'diary_list',
    description: '看历史日记存档（本地 diary/），按日期倒序。写新日记前可以翻翻昨天写了什么，别重复。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '看几篇，默认 7' },
      },
    },
    run: diaryList,
  },
  {
    name: 'random_image',
    description: '随机图：说「来张随机图」「随便来张」「来点涩图」时用，走 lolicon（pixiv 图库，20 万+ 张，直连可用）。默认 R18 池（r18="only"）；也可按 tag/keyword/画师 uid/长宽比筛，最多一次 10 张。不传 key 只返回链接。asFile=true 按文件发原图。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'group:群号 或 private:QQ号，传了就发出去' },
        tags: { type: 'array', items: { type: 'string' }, description: 'tag，最多 3 个（AND），日文命中率最高，如 ["中出し","巨乳"]' },
        keyword: { type: 'string', description: '按标题关键词搜（和 tag 二选一或叠加）' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: '发几张，默认 1，最多 10' },
        size: { type: 'string', enum: ['regular', 'original'], description: '默认 regular' },
        excludeAI: { type: 'boolean', description: 'true 排除 AI 生成的图' },
        aspectRatio: { type: 'string', description: '只要某个方向的图：horizontal / vertical / square' },
        uid: { type: 'string', description: '只从某个画师 uid 里抽' },
        r18: { type: 'boolean', description: 'true 时只出/优先 R18（默认按工具说明）' },
      },
    },
    run: randomImage,
  },
  {
    name: 'server_status',
    description: '查这台服务器现在的状况：内存、负载、磁盘、服务是否在跑、QQ 容器状态。有人问“服务器怎么样/内存还剩多少/卡不卡”时用，数字是真的，别自己猜。',
    inputSchema: { type: 'object', properties: { detail: { type: 'boolean', description: 'true 时多给内存占用最高的进程和监听端口' } } },
    run: serverStatus,
  },
  {
    name: 'comic_info',
    description: '查漫画/番剧/轻小说的文字资料：标题（中日英）、作者、话数册数、评分、标签、简介。只返回文字，不下载任何内容。用户提到某部作品想了解时用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '作品名（中文/日文/英文都试）' },
        id: { type: 'string', description: '已知条目 id 时直接查详情' },
        detail: { type: 'boolean', description: 'true 时把 query 当 id 查详情' },
      },
    },
    run: comicInfo,
  },
  {
    name: 'anime_search',
    description: '以图搜图：给一张图的地址，反查出处。返回番剧集数/角色名/画师作品/Pixiv 原图链接。对方发图问「这是哪部」「这是谁」「出处呢」时用。sources 可选：tracemoe（番剧截图）、ascii2d（Pixiv/Twitter 反查）、animetrace（角色识别）、saucenao（需 key）、soutubot、aidefect。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片地址' },
        imageId: { type: 'string', description: '图库里的 id（和 url 二选一）' },
        sources: { type: 'array', items: { type: 'string' }, description: '只跑指定源' },
      },
    },
    run: animeSearch,
  },
  {
    name: 'chart_generator',
    description: '[新增] 专业数据图表渲染：bar（柱状/分组柱）/ line（折线趋势）/ pie（环形饼图）/ radar（多维雷达），300dpi 高清 + 中文字体不乱码。style=academic 学术白底深蓝、style=transparent 透明背景（适合叠深色 PPT）。传 key 直接发到会话，不传返回本地路径（可嵌入 file_make 的 PPT）。严禁用 image_generate 画数据图表；返回后必须消化成 1 句简短回复点出核心结论，禁止输出 JSON 原文或长列表。',
    inputSchema: {
      type: 'object',
      properties: {
        chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'radar'], description: '默认 bar' },
        title: { type: 'string', description: '图表标题，≤40 字' },
        labels: { type: 'array', items: { type: 'string' }, description: 'X 轴/维度标签' },
        datasets: {
          type: 'array',
          description: '数据系列：[{"name":"同比","values":[5.3,5.0]}]；radar 至少 3 个维度',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['name', 'values'],
          },
        },
        style: { type: 'string', enum: ['academic', 'transparent'], description: '默认 academic' },
        unit: { type: 'string', description: '数值后缀，如 % 或 亿元' },
        width: { type: 'number', description: '可选，英寸宽（默认 9.6）' },
        height: { type: 'number', description: '可选，英寸高（默认 5.4）' },
        key: { type: 'string', description: '可选：发到这个会话（group:群号 / private:QQ号）' },
      },
      required: ['chartType', 'labels', 'datasets'],
    },
    run: chartGenerator,
  },
  {
    name: 'render_png',
    description: '把文字/LaTeX 渲染成 PNG 图片。行内公式用 $a^2+b^2=c^2$，整段用 $$...$$ 或直接贴 \\frac{...} 这样的裸 LaTeX。传 key 就直接发到会话，不传只返回路径。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要渲染的内容，支持中英混排 + 行内公式' },
        key: { type: 'string', description: 'group:群号 或 private:QQ号，传了就发出去' },
        fontsize: { type: 'integer', minimum: 10, maximum: 60, description: '字号，默认 22' },
        color: { type: 'string', description: '文字颜色，默认 #111111' },
        bg: { type: 'string', description: 'white / transparent / #rrggbb，默认 white' },
        maxwidth: { type: 'integer', description: '输出宽度上限，默认 1080' },
      },
      required: ['text'],
    },
    run: renderPng,
  },
  {
    name: 'bili_dm_send',
    description: '在 B站发私信。to 是对方 mid（bili_dm_list 的 talker）。',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, message: { type: 'string' } }, required: ['to', 'message'] },
    run: biliDmSend,
  },
  {
    name: 'bili_feed',
    description: '看 B站上「@我的」和「回复我的」。返回发送者、内容、以及回帖需要的 oid/root/parent/type。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: biliFeed,
  },
  {
    name: 'bili_reply',
    description: '在 B站回帖/评论。参数用 bili_feed 返回的 oid/root/parent/type，message 是要说的话。',
    inputSchema: {
      type: 'object',
      properties: {
        oid: { type: 'integer', description: 'bili_feed 的 oid' },
        type: { type: 'integer', description: '评论类型，视频 1、动态 17' },
        root: { type: 'integer', description: '楼中楼根评论 id，0 表示直接评论' },
        parent: { type: 'integer', description: '回复哪条评论（parent）' },
        message: { type: 'string' },
      },
      required: ['oid', 'message'],
    },
    run: biliReply,
  },
  {
    name: 'bili_login',
    description: 'B站扫码登录：生成二维码发到当前会话，手机扫码后自动保存账号 cookie。之后搜索/推荐都用这个账号。',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'group:群号 或 private:QQ号，二维码发到这里' } },
    },
    run: biliLogin,
  },
  {
    name: 'memory_recall',
    description: '按需求取回允许读取的记忆碎片清单（LOD：l0 总纲 / l1 主题 / l2 细节）。每轮开始先调它，别凭印象答。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        need: { type: 'string', description: '当前对话要解决什么' },
        budget: { type: 'integer', minimum: 400, maximum: 4000, description: 'token 预算，默认 1500' },
      },
      required: ['need'],
    },
    run: memoryRecall,
  },
  {
    name: 'memory_write',
    description: '写一段记忆碎片。只写事实：禁止日期、更新时间、变更记录，命中会被拒。超行数会报错要求拆成多个碎片。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '分类目录：人物 / 项目 / 技术 / 偏好 / 环境' },
        slug: { type: 'string', description: '短名，如 主人-服务器' },
        lod: { type: 'string', enum: ['l0', 'l1', 'l2'], description: '默认 l1' },
        content: { type: 'string', description: 'markdown 事实列表' },
        append: { type: 'boolean', description: '追加而不是覆盖' },
        theme: { type: 'object', description: 'pptx 主题：{bg:"#0B1F33",accent:"#FB7299",text:"#FFFFFF",font:"Microsoft YaHei"}' },
        cover: { type: 'string', description: 'pptx 封面背景图：服务器路径或图片 URL' },
      },
      required: ['category', 'slug', 'content'],
    },
    run: memoryWrite,
  },
  {
    name: 'web_search',
    description: '网页搜索：engine=auto（默认，exa → tavily → 360 → sogou → bing）或指定单个引擎。exa 免 key 约 30 次后限流、tavily 约 21 次/小时，都会自动降级。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        engine: { type: 'string', enum: ['auto', 'exa', 'tavily', 'bing', '360', 'sogou', 'google'], description: '默认 auto（exa → tavily → 360 → sogou → bing）' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '条数，默认 6' },
      },
      required: ['query'],
    },
    run: webSearch,
  },
  {
    name: 'image_generate',
    description: 'AI 画图（Pollinations flux，免 key）：给一段提示词生成图片。传 key 则直接发到该 QQ 会话。提示词建议写英文、具体（画面+风格+构图）。只生成，不搜网图。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画什么，英文效果更好' },
        key: { type: 'string', description: '可选：group:群号 或 private:QQ号，传了就直接发过去' },
        width: { type: 'integer', minimum: 256, maximum: 1024, description: '宽，默认 1024' },
        height: { type: 'integer', minimum: 256, maximum: 1024, description: '高，默认 1024' },
        model: { type: 'string', description: '默认 flux；其他值可能 402' },
        count: { type: 'integer', minimum: 1, maximum: 2, description: '生成几张，默认 1（免费额度每 45 秒 1 张，多张会等）' },
      },
      required: ['prompt'],
    },
    run: imageGenerate,
  },
  {
    name: 'chat_history',
    description: '查聊天记录：给 group:群号 或 private:QQ号，读最近 N 条（最多 100，支持 50~100 条爬楼省流摘要），可选关键词过滤。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        count: { type: 'integer', minimum: 1, maximum: 100, description: '最近多少条，默认 20（爬楼总结可传 50~100）' },
        keyword: { type: 'string', description: '可选：只在内容/昵称里含这个词的记录' },
      },
      required: ['key'],
    },
    run: chatHistory,
  },
  {
    name: 'chat_search',
    description: '跨会话聊天记录互通（默认覆盖全部白名单群聊与私聊）：传 keyword 按关键词/人名/QQ号搜；不传 keyword 则按活跃时间总览各群与私聊最新动态，方便互通多边对话与写日记。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：关键词/昵称/QQ号；不填则总览各会话最新消息' },
        scope: { type: 'string', enum: ['all', 'groups', 'private'], description: '范围：all（默认，群+私聊）/ groups / private' },
        keys: { type: 'array', items: { type: 'string' }, description: '可选：限定要搜的会话 key 列表' },
        perKey: { type: 'integer', minimum: 1, maximum: 100, description: '每个会话看多少条，搜词默认 30，总览默认 8' },
      },
    },
    run: chatSearch,
  },
  {
    name: 'web_link_parse',
    description: '[Gemini修改 / 新增Skill] 网页与B站链接/BV号解析：自动识别 http(s) 链接、BV号、b23.tv 短链或 cv 专栏，提取标题/UP主/播放量/简介/热评或网页摘要，并自动提取【网页内嵌统计图表与图片列表】（绝对 URL）。禁止直接输出长列表或说明书腔，必须消化成 30 字以内的简短口语回复。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '链接、b23.tv 短链、BV号或包含链接的文本' },
        url: { type: 'string', description: '同 input，可选别名' },
      },
    },
    run: webLinkParse,
  },
  {
    name: 'qq_schedule_reminder',
    description: '[Gemini修改 / 新增Skill] 持久化定时唤醒与主动验收工具：数据落盘重启不丢失。支持「几点喊我」生活提醒与私聊立规矩后的到点查岗验收。到点后会自动唤醒自己主动发消息。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'add=新增 / list=查看 / remove=删除' },
        targetType: { type: 'string', enum: ['private', 'group'], description: 'add 时必填：private 或 group' },
        targetId: { type: 'string', description: 'add 时必填：QQ 号或群号' },
        triggerTime: { type: 'string', description: 'add 时必填：相对延迟（如 5m / 30m / 2h）或绝对时间（HH:mm / YYYY-MM-DD HH:mm）' },
        content: { type: 'string', description: 'add 时必填：提醒事由或验收事项' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly'], description: '可选重复周期，默认 none' },
        id: { type: 'string', description: 'remove 时必填：定时任务 id' },
      },
      required: ['action'],
    },
    run: qqScheduleReminder,
  },
  {
    name: 'fun_dice_fortune',
    description: '[Gemini修改 / 新增Skill] 今日运势抽签与跑团掷骰工具：mode=fortune 按 QQ 号与当天日期生成稳定今日运势宜忌；mode=dice 解析 1d100 / 2d6 / 1d20+3 等骰子表达式。禁止照搬输出格式，必须消化成 30 字内简短回复点评。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fortune', 'dice'], description: 'fortune=今日运势 / dice=掷骰' },
        qq: { type: 'string', description: 'fortune 时传用户 QQ 号' },
        expr: { type: 'string', description: 'dice 时的表达式，如 1d100、2d6' },
      },
    },
    run: funDiceFortune,
  },
  {
    name: 'meme_caption',
    description: '[Gemini修改 / 新增Skill] 梗图加字工具：在传入图片 URL、图库 imageId 或内置表情包模板的底部/顶部添加简短中文配字生成新图。传 key 会直接发到指定会话。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '可选：会话 key（group:群号 或 private:QQ号），传了就直接发过去' },
        text: { type: 'string', description: '要加的中文配字（简短更有梗）' },
        position: { type: 'string', enum: ['bottom', 'top', 'both'], description: '文字位置，默认 bottom' },
        bottomText: { type: 'string', description: 'position=both 时的底部配字' },
        url: { type: 'string', description: '可选：原图 URL' },
        imageId: { type: 'string', description: '可选：本地图库 imageId' },
      },
      required: ['text'],
    },
    run: memeCaption,
  },
  {
    name: 'qzone_feed',
    description: '[Gemini修改 / 第二阶段新增Skill] 刷 QQ 空间好友动态：只读。调用时必须传当前会话 key（group:群号 或 private:QQ号），工具会自动过滤，只返回本群成员或当前私聊对象的动态，严禁把别人的空间动态发到没有当事人的无关群聊！',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '当前会话 key（group:群号 或 private:QQ号），传入后自动过滤只留当前会话成员动态' },
        targetUin: { type: 'string', description: '可选：指定好友 QQ 号' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: '读取条数，默认 8' },
        cursor: { type: 'string', description: '可选：翻页游标 next_cursor' },
      },
    },
    run: qzoneFeed,
  },
  {
    name: 'qq_send_tts_voice',
    description: '[Gemini修改 / 第二阶段新增Skill] 轻量 Edge-TTS 少女语音条（3~6秒，限 80 字内，每 3 分钟冷却）：默认仅限私聊（晚安/早起叫醒/撒娇）；群聊仅在被明确要求发语音时传 allowGroup=true，严禁刷屏。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key：private:QQ号 或 group:群号' },
        text: { type: 'string', description: '要说的话，≤80 字（纯口语，不带颜文字和括号）' },
        voice: { type: 'string', description: '可选音色，默认按 mood 选（XiaoyiNeural / XiaoxiaoNeural）' },
        mood: { type: 'string', enum: ['energetic', 'playful', 'sleepy'], description: '可选情绪：energetic=日常元气 / playful=傲娇调皮 / sleepy=深夜软萌；不传则按当前时间自动选' },
        engine: { type: 'string', enum: ['auto', 'gemini', 'edge'], description: '可选引擎：auto=先用 Gemini（音质更自然，走本地代理）失败回退 edge-tts；gemini=强制 Gemini；edge=强制本地 edge-tts' },
        allowGroup: { type: 'boolean', description: '群聊明确要求发语音时传 true，默认 false' },
      },
      required: ['key', 'text'],
    },
    run: qqSendTtsVoice,
  },
  {
    name: 'qq_quote_archive',
    description: '[Gemini修改 / 新增Skill] 群聊「立 Flag 与名场面档案馆」：悄悄记录群友立下的 Flag、离谱错别字或神金句（add），在对方破功时标记并生成公开处刑语录小卡片或月底生成《本群月度发疯语录图》（bust / card / list / remove）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'bust', 'card', 'remove'], description: 'add=收录 / list=查看 / bust=标记Flag破功 / card=生成语录卡或月度海报 / remove=删除' },
        groupId: { type: 'string', description: '群号（纯数字）' },
        speaker: { type: 'string', description: '发言人昵称' },
        qq: { type: 'string', description: '可选：发言人 QQ 号' },
        quote: { type: 'string', description: '原话内容' },
        kind: { type: 'string', enum: ['flag', 'typo', 'quote', 'monthly'], description: 'flag=立Flag / typo=离谱错别字 / quote=神金句 / monthly=生成月度语录图' },
        id: { type: 'string', description: '记录 id（bust / card / remove 可用）' },
        month: { type: 'string', description: '可选：YYYY-MM，用于生成月度语录图或筛选' },
        key: { type: 'string', description: 'card 时可选：传 group:群号 或 private:QQ号 直接把卡片发到会话' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'list 条数' },
      },
      required: ['action'],
    },
    run: qqQuoteArchive,
  },
  {
    name: 'qq_topic_radar',
    description: '[Gemini修改 / 新增Skill] 跨群「脱敏吃瓜雷达」公共话题词池：在后台记录纯公共讨论（游戏更新/新番口碑/网络热梗），严禁包含任何群号、QQ号、昵称或私聊隐私。某群冷场时可调 list 挑一个自然破冰。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'add=收录公共话题 / list=查看公共话题池 / remove=删除' },
        topic: { type: 'string', description: 'add 时必填：纯公共话题摘要（≤80字，绝不含隐私/群号/人名）' },
        category: { type: 'string', enum: ['游戏', '番剧', '热梗', '科技', '日常'], description: '话题分类' },
        id: { type: 'string', description: 'remove 时的 id' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['action'],
    },
    run: qqTopicRadar,
  },
  {
    name: 'video_peek',
    description: '[Gemini修改 / 新增Skill] 短视频抽关键帧看画面：用 ffmpeg 抽取 6 帧拼成 3×2 网格图直接返回给视觉模型看懂画面（支持 QQ 视频 url、mp4 直链或 B站 bvid）。适合搞笑短视频、无旁白片段、游戏操作集锦。看懂后只用 1~2 条 30 字内简短回复吐槽，严禁逐帧念图。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频直链或 B站视频链接' },
        bvid: { type: 'string', description: '可选：B站 BV 号' },
        path: { type: 'string', description: '可选：服务器本地视频路径' },
        frames: { type: 'integer', minimum: 4, maximum: 9, description: '抽几帧，默认 6（3×2 网格）' },
        maxSeconds: { type: 'integer', minimum: 5, maximum: 180, description: '最多看前多少秒，默认 60' },
      },
    },
    run: videoPeek,
  },
  {
    name: 'video_transcribe',
    description: '把视频的语音转成文字（本地 Paraformer）：给 B站链接/BV号、视频直链（mp4/m4a），或用 bili_search 找到的 BV。B站走 dash 音频流，自动截取前 N 秒。适合「这个视频讲了什么」「听听这个视频」。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'B站视频链接或视频/音频直链' },
        bvid: { type: 'string', description: '也可以直接给 BV 号' },
        maxSeconds: { type: 'integer', minimum: 30, maximum: 1800, description: '最多转写前多少秒，默认 300' },
        maxChars: { type: 'integer', minimum: 500, maximum: 20000, description: '最多返回多少字符，默认 6000' },
      },
    },
    run: videoTranscribe,
  },
  {
    name: 'bili_search',
    description: 'B站站内搜索：kind=article 搜专栏（中文攻略/台词整理/考据），kind=video 搜视频。当通用搜索引擎对中文游戏资料给不出结果时用这个。返回标题/链接/作者。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，如「Apex 台词」' },
        kind: { type: 'string', enum: ['article', 'video'], description: '默认 article' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '条数，默认 5' },
      },
      required: ['query'],
    },
    run: biliSearch,
  },
  {
    name: 'bili_article',
    description: '读 B站专栏正文（cv 号或链接）：走 read/mobile 服务端渲染页抽文本。bili_search 搜到专栏后用它读全文。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '专栏 cv 号，如 18369810' },
        url: { type: 'string', description: '或直接给 https://www.bilibili.com/read/cv18369810' },
        maxChars: { type: 'integer', minimum: 500, maximum: 20000, description: '最多返回多少字符，默认 6000' },
      },
    },
    run: biliArticle,
  },
  {
    name: 'site_search',
    description: '限定站点做搜索（Bing + site: 语法）。当通用搜索只回官网/百科首页、找不到具体资料时用它，比如 site=apexlegends.fandom.com 或 site=bilibili.com、site=zhihu.com、site=3dmgame.com。返回标题/链接/摘要。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的词' },
        site: { type: 'string', description: '限定域名，如 apexlegends.fandom.com（可省略）' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '条数，默认 5' },
      },
      required: ['query'],
    },
    run: siteSearch,
  },
  {
    name: 'page_text',
    description: '[Gemini修改] 把一个网页抓成纯文本（去标签/脚本），并自动提取【网页内嵌统计图表与图片列表】（已解析为完整 HTTP(S) 绝对链接，可直接传给 file_make 的 image 参数），用来读正文、统计公报、研报、百科条目。配合 site_search 用：先搜到链接，再抓正文。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标页面 URL' },
        maxChars: { type: 'integer', minimum: 500, maximum: 20000, description: '最多返回多少字符，默认 6000' },
      },
      required: ['url'],
    },
    run: pageText,
  },
  {
    name: 'pixiv_search',
    description: 'pixiv 官方搜索（走代理隧道，需要 VPN 开着）：按关键词搜作品，返回标题/画师/收藏数/尺寸。要搜 R18 传 r18=true（mode=r18，未登录的 pixiv 搜不到 R18）。比 pixivic 覆盖广，能按收藏排序。隧道不通会直接报错——那时改用 pixivic_search。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（日文命中率最高）' },
        count: { type: 'integer', description: '返回几条，默认 5' },
        page: { type: 'integer', description: '第几页，默认 1' },
        sort: { type: 'string', description: 'popular=按收藏排，否则接口原序' },
        safeOnly: { type: 'boolean', description: 'true 只留全年龄（pixiv 的 xRestrict=0）' },
        r18: { type: 'boolean', description: 'true 时只出/优先 R18（默认按工具说明）' },
      },
      required: ['query'],
    },
    run: pixivSearch,
  },
  {
    name: 'pixiv_send',
    description: 'pixiv 官方搜图并直接发到会话（走代理隧道，需要 VPN）。要 R18 传 r18=true。count 最多 3；asFile 走文件模式发原图。隧道不通会直接报错——那时改用 pixivic_send。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'group:群号 或 private:QQ号' },
        query: { type: 'string', description: '关键词' },
        count: { type: 'integer', description: '张数，默认 1，最多 3' },
        safeOnly: { type: 'boolean', description: 'true 只留全年龄' },
        r18: { type: 'boolean', description: 'true 时只出/优先 R18（默认按工具说明）' },
      },
      required: ['key', 'query'],
    },
    run: pixivSend,
  },
  {
    name: 'pixivic_search',
    description: 'pixivic.com 搜图（后端 pix.ipv4.host，需登录 token）。默认含 R18（r18=true，用明确 R18 的 tag 组合；传 r18=false 走擦边档）；safeOnly=true 才只留全年龄。返回标题/画师/尺寸/标签/图片直链。未配置 token 时会返回获取方法。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: '返回几件，默认 5' },
        page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
        pageSize: { type: 'integer', minimum: 1, maximum: 50, description: '单页抓多少，默认 20' },
        r18: { type: 'boolean', description: 'true 时只出/优先 R18（默认按工具说明）' },
      },
      required: ['query'],
    },
    run: pixivicSearch,
  },
  {
    name: 'pixivic_send',
    description: '涩图专用：说「来点涩图」「来点刺激的」时用，走 pixivic（pixiv 镜像），一次 3 张。**默认 asFile=true：下原图（2000~4000px, 10~20MB）按文件发，QQ 不压缩**；只有对方明确说「随便发两张看看」时才传 asFile=false（发图片消息，1200px）。要清楚就文件，别自己改成图片模式。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        query: { type: 'string', description: '关键词' },
        count: { type: 'integer', minimum: 1, maximum: 3, description: '发几张，默认 1' },
        r18: { type: 'boolean', description: 'true 时只出/优先 R18（默认按工具说明）' },
      },
      required: ['key', 'query'],
    },
    run: pixivicSend,
  },
  {
    name: 'bili_recommend',
    description: 'B站视频推荐：mode=popular 热门、mode=ranking 全站排行、mode=search 按关键词搜视频。返回标题/UP主/播放量/时长/链接。适合「推荐点视频」「B站有什么好看的」「搜点 xx 视频」。只读，不需要登录。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['popular', 'ranking', 'search'], description: '默认 popular' },
        keyword: { type: 'string', description: 'mode=search 时的关键词' },
        rid: { type: 'integer', description: 'ranking 分区 id（0=全站；1=动画 3=音乐 4=游戏 36=科技…）' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '条数，默认 5' },
      },
    },
    run: biliRecommend,
  },
  {
    name: 'song_lyrics',
    description: '拿一首歌的歌词（含中文翻译）。给 id 或 query+index；点歌之后想聊歌词、被问「这歌讲什么」时用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '网易云歌曲 id' },
        query: { type: 'string', description: '歌名/歌手（没 id 时用）' },
        index: { type: 'number', description: '搜到多首时取第几首，默认 1' },
        maxChars: { type: 'number', description: '最多返回多少字，默认 3000' },
      },
    },
    run: songLyrics,
  },
  {
    name: 'song_playlist',
    description: '歌单管理：action=list 看所有歌单、create 建歌单（name）、add 加歌（playlist+query 或 songId）、remove 删歌（playlist+query 关键词）。群友点过的歌可以攒起来。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'add', 'remove'], description: '要做什么' },
        playlist: { type: 'string', description: '歌单名' },
        name: { type: 'string', description: 'create 时的歌单名' },
        query: { type: 'string', description: '歌名/歌手关键词' },
        songId: { type: 'string', description: '已知网易云 id 时直接用' },
        index: { type: 'number', description: '搜到多首取第几首，默认 1' },
        note: { type: 'string', description: '给这首歌的备注' },
      },
    },
    run: playlistTool,
  },
  {
    name: 'music_search',
    description: '按关键词搜歌（网易云搜索，相关性准）。返回歌名/歌手/id。适合「有什么歌」「搜一下 xx」；要真的放出来用 music_play。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名、歌手或「歌手 歌名」' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '条数，默认 5' },
      },
      required: ['query'],
    },
    run: musicSearch,
  },
  {
    name: 'music_play',
    description: '点歌并直接以 QQ 语音发到当前会话。key 填会话（group:群号 或 private:QQ号），query 是搜索词、index 选第几首（从 1 开始），也可以直接给音乐 id。搜索走网易云、播放走酷我，自动对齐同名版本。一首歌整段发出去，会占用几十秒。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        query: { type: 'string', description: '搜索词（不传 id 时必填）' },
        index: { type: 'integer', minimum: 1, maximum: 10, description: '选第几首，默认 1' },
        id: { type: 'string', description: '音乐 id（可选，传了就不搜索）' },
      },
      required: ['key'],
    },
    run: musicPlay,
  },
  {
    name: 'image_post',
    description: '普通搜图：说「找几张 xx 的图」「搜点 xx 图」时用，走搜索引擎（360/必应/搜狗），发到会话。涩图不要用这个，用 pixivic_send。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        query: { type: 'string', description: '搜图关键词；safebooru 源可写多 tag' },
        count: { type: 'integer', minimum: 1, maximum: 6, description: '发几张，默认 2' },
        source: { type: 'string', enum: ['all', '360', 'bing', 'sogou', 'safebooru'], description: '默认 all' },
        page: { type: 'integer', minimum: 1, description: '指定翻到第几页；不传则随机' },
      },
      required: ['key', 'query'],
    },
    run: imagePost,
  },
  {
    name: 'sticker_list',
    description: '看表情包有哪些分类和每个分类的可用表情名（15 类：happy/angry/sad/confused/surprised/shy/sleep/affection/food/money/greeting/work/entertainment/teasing/reply）。发之前先看这个，别瞎猜分类。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '可选：看某一类里有哪些具体表情' },
      },
    },
    run: stickerList,
  },
  {
    name: 'sticker_send',
    description: '发表情包到当前会话（QQ 图片消息，会自动发对应的 GIF）。category 用 sticker_list 里的英文分类，表达情绪/接话时用；不要刷屏，一次 1 张最常见。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号' },
        category: { type: 'string', description: '分类：happy/angry/sad/confused/surprised/shy/sleep/affection/food/money/greeting/work/entertainment/teasing/reply' },
        count: { type: 'integer', minimum: 1, maximum: 3, description: '发几张，默认 1' },
        name: { type: 'string', description: '可选：按文件名片段精确挑（如「爱心」「打游戏」）' },
      },
      required: ['key'],
    },
    run: stickerSend,
  },
  ...createDoujinTools({ sendImageTo, sendFileToChat, log }),
  // ...createBooruTools({ sendImageTo, log }),   // 已下线：tbib 图太老，主人指定用 pixivic
];

// ── JSON-RPC / MCP ─────────────────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// ── 重任务并发控制 ────────────────────────────────────────────────
// 8G 内存下允许最多 2 个重任务同时跑（下载/转码/解析），再多就排队。
// 轻量只读工具完全不排队，随时响应。
const LIGHT_TOOLS = new Set([
  'server_status', 'memory_recall', 'memory_read', 'memory_tree', 'chat_history', 'chat_search',
  'web_link_parse', 'fun_dice_fortune', 'qq_schedule_reminder', 'qzone_feed', 'qq_topic_radar',
  'song_lyrics', 'comic_info', 'sticker_list', 'diary_list', 'web_search', 'page_text',
  'hot_topic', 'music_search', 'site_search', 'bili_feed', 'bili_dm', 'qq_profile',
]);

const HEAVY_CONCURRENCY = 2;        // 重任务并行数（内存 ≥7G 时用 2，小内存改 1）

let running = 0;
const waiters = [];

function acquire() {
  if (running < HEAVY_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) next();          // 名额直接转交，running 不变
  else running = Math.max(0, running - 1);
}

async function serialize(name, fn) {
  if (LIGHT_TOOLS.has(name)) return fn();
  const started = Date.now();
  if (running >= HEAVY_CONCURRENCY) {
    log(`排队等待：${name}（正在跑 ${running} 个重任务）`);
  }
  await acquire();
  try {
    return await fn();
  } finally {
    releaseSlot();
    const ms = Date.now() - started;
    if (ms > 3000) log(`重任务完成：${name} 用时 ${Math.round(ms / 1000)}s（并发 ${running}）`);
  }
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'qq-content', version: VERSION },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS.map(({ run, ...t }) => t) });
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return fail(id, -32602, `unknown tool: ${name}`);
    try {
      const res = await serialize(name, () => tool.run(params?.arguments ?? {}));
      // Gemini修改：支持工具返回多模态 content（如 video_peek 的 image 块）
      if (res && typeof res === 'object' && Array.isArray(res.__mcpContent)) {
        return ok(id, { content: res.__mcpContent, isError: false });
      }
      return ok(id, { content: [{ type: 'text', text: String(res ?? '') }], isError: false });
    } catch (error) {
      log(`${name} failed:`, error?.message ?? error);
      return ok(id, { content: [{ type: 'text', text: `${name} 调用失败：${error?.message ?? error}` }], isError: true });
    }
  }
  return fail(id, -32601, `unknown method: ${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closing = false;
const maybeExit = () => {
  if (closing && pending === 0) process.exit(0);
};
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { log('bad json line'); return; }
  pending += 1;
  Promise.resolve(handle(msg))
    .catch((e) => log('handler error', e?.message ?? e))
    .finally(() => { pending -= 1; maybeExit(); });
});
// stdin 关了不代表活干完了：等在途请求排空再退出，否则异步 tools/call 会被掐断。
rl.on('close', () => { closing = true; maybeExit(); });
log(`ready v${VERSION} tools=${TOOLS.map((t) => t.name).join(',')}`);
