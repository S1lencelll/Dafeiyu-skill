// 记忆库（LOD 分片）——每个 .md 是一段记忆碎片，只记事实，不记时间和变更。
//
// 目录：memory/<分类>/<lod>-<slug>.md
//   l0-  分类总纲，一句话一条，全局常驻
//   l1-  主题块，10~20 条事实
//   l2-  细节片段，只在需要时展开
//
// 读取规则：memory_recall(need) 按「目录名 / 文件名 / 需求」打分，按预算返回**允许读**的文件。
// 写入规则：拒绝时间与变更记录；只在读到的 LOD 范围内改。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const MEMORY_ROOT = `${ROOT}/memory`;

const TAXONOMY = [
  ['人物', '关于具体的人：身份、关系、习惯、说过的话'],
  ['项目', '在做的事：目标、结构、当前状态'],
  ['技术', '可复用的事实：接口、命令、参数、踩过的坑'],
  ['偏好', '喜恶与风格：要什么、不要什么'],
  ['环境', '机器、路径、账号、网络'],
];

const LOD_WEIGHT = { l0: 3, l1: 2, l2: 1 };
const LOD_BUDGET = { l0: 999, l1: 6, l2: 3 };
const MAX_FILE_LINES = { l0: 40, l1: 60, l2: 200 };

const FORBIDDEN = [
  /^\s*[-*]?\s*\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/m,
  /更新(时间|记录|日志)/,
  /变更(记录|历史)/,
  /修改(记录|历史)/,
  /^\s*#{1,3}\s*(时间|日期|更新|变更)/m,
];

export function ensureTree() {
  mkdirSync(MEMORY_ROOT, { recursive: true });
  for (const [name, desc] of TAXONOMY) {
    const dir = join(MEMORY_ROOT, name);
    mkdirSync(dir, { recursive: true });
    const readme = join(dir, '_about.md');
    if (!existsSync(readme)) writeFileSync(readme, `# ${name}\n- ${desc}\n`, 'utf8');
  }
}

function safePath(rel) {
  const abs = resolve(MEMORY_ROOT, rel);
  if (abs !== MEMORY_ROOT && !abs.startsWith(MEMORY_ROOT + sep)) throw new Error('路径越界');
  return abs;
}

function lodOf(file) {
  const m = /^(l[012])-/i.exec(basename(file));
  return m ? m[1].toLowerCase() : 'l1';
}

function titleOf(text, fallback) {
  const m = /^#\s*(.+)$/m.exec(text);
  return (m ? m[1] : fallback).trim();
}

function linesOf(text) {
  return text.split('\n').filter((l) => l.trim()).length;
}

function tokens(s) {
  const t = String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out = new Set();
  for (const w of t.split(/\s+/)) if (w) out.add(w);
  // 中文没有空格：补 2-gram
  for (const run of t.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

function score(file, need) {
  const rel = relative(MEMORY_ROOT, file);
  const cat = rel.split(sep)[0] ?? '';
  const slug = basename(file, '.md').replace(/^l[012]-/i, '');
  const nt = tokens(need);
  let s = 0;
  for (const ch of cat) if (need.includes(ch)) s += 1.5;
  for (const tk of tokens(slug)) if (nt.has(tk)) s += 2.5;
  if (need && need.includes(slug)) s += 4;
  const lod = lodOf(file);
  s += LOD_WEIGHT[lod] * 0.6;
  return { score: s, cat, slug, lod };
}

export function listFiles() {
  ensureTree();
  const out = [];
  for (const cat of readdirSync(MEMORY_ROOT)) {
    const dir = join(MEMORY_ROOT, cat);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f === '_about.md') continue;
      out.push(join(dir, f));
    }
  }
  return out;
}

/** 依据需求返回「允许读取」的文件清单（不含正文） */
export function recall(need = '', budget = 1500) {
  const files = listFiles();
  const scored = files.map((f) => {
    const meta = score(f, String(need));
    const text = readFileSync(f, 'utf8');
    return { path: relative(MEMORY_ROOT, f), ...meta, title: titleOf(text, meta.slug), lines: linesOf(text) };
  });

  // L0 常驻：每个分类都带一份
  const picked = [];
  const perLod = { l0: 0, l1: 0, l2: 0 };
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    if (perLod[item.lod] >= LOD_BUDGET[item.lod]) continue;
    // L1/L2 必须与需求相关，避免无关内容挤进预算
    if (item.lod !== 'l0' && item.score < 2) continue;
    picked.push(item);
    perLod[item.lod] += 1;
  }

  // 预算裁剪：按行数估算，先砍最低分的 L2
  let used = 0;
  const kept = [];
  for (const item of picked) {
    const cost = item.lines * 12;
    if (used + cost > budget && item.lod !== 'l0') continue;
    kept.push(item);
    used += cost;
  }
  return { need, budget, used, files: kept };
}

export function readFragment(rel, maxLines = 200) {
  const abs = safePath(rel);
  if (!existsSync(abs)) throw new Error(`记忆不存在：${rel}`);
  const lines = readFileSync(abs, 'utf8').split('\n');
  return { path: rel, truncated: lines.length > maxLines, text: lines.slice(0, maxLines).join('\n') };
}

function checkContent(content) {
  for (const re of FORBIDDEN) {
    const m = re.exec(content);
    if (m) throw new Error(`记忆只记事实，不写时间和变更记录：命中「${String(m[0]).trim()}」`);
  }
}

export function writeFragment({ category, slug, lod = 'l1', content, append = false }) {
  ensureTree();
  const cat = String(category ?? '').trim();
  if (!cat || cat.includes('/') || cat.includes('\\')) throw new Error('分类只能是单层目录名');
  const s = String(slug ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  if (!s) throw new Error('slug 不能为空');
  const level = ['l0', 'l1', 'l2'].includes(String(lod)) ? String(lod) : 'l1';
  const body = String(content ?? '').trim();
  if (!body) throw new Error('内容不能为空');
  checkContent(body);

  mkdirSync(join(MEMORY_ROOT, cat), { recursive: true });
  const abs = join(MEMORY_ROOT, cat, `${level}-${s}.md`);
  let text = body;
  if (append && existsSync(abs)) {
    const old = readFileSync(abs, 'utf8');
    checkContent(old);
    text = `${old.trimEnd()}\n${body}`;
  }
  const lines = text.split('\n').length;
  if (lines > MAX_FILE_LINES[level]) {
    throw new Error(`${level} 超过 ${MAX_FILE_LINES[level]} 行，拆成多个碎片或降一级（l1→l2）`);
  }
  writeFileSync(abs, `${text}\n`, 'utf8');
  return { path: relative(MEMORY_ROOT, abs), lines, lod: level };
}

/** 只替换读取范围内的原文，不做整篇重写 */
export function patchFragment({ path: rel, old, replacement }) {
  const abs = safePath(rel);
  if (!existsSync(abs)) throw new Error(`记忆不存在：${rel}`);
  const text = readFileSync(abs, 'utf8');
  if (!text.includes(old)) throw new Error('原文没有精确命中，先 memory_open 确认要改的那几行');
  const next = text.replace(old, replacement);
  checkContent(next);
  writeFileSync(abs, next, 'utf8');
  return { path: rel, changed: true };
}

export function moveFragment({ path: rel, toCategory, rename }) {
  const abs = safePath(rel);
  if (!existsSync(abs)) throw new Error(`记忆不存在：${rel}`);
  const cat = String(toCategory ?? dirname(rel).split(sep)[0]).trim();
  mkdirSync(join(MEMORY_ROOT, cat), { recursive: true });
  const name = rename
    ? `${lodOf(abs)}-${String(rename).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}.md`
    : basename(abs);
  const next = join(MEMORY_ROOT, cat, name);
  if (next === abs) return { path: rel, moved: false };
  renameSync(abs, next);
  return { from: rel, path: relative(MEMORY_ROOT, next) };
}

export function tree() {
  ensureTree();
  const out = [];
  for (const cat of readdirSync(MEMORY_ROOT).sort()) {
    const dir = join(MEMORY_ROOT, cat);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_about.md').sort();
    out.push({ category: cat, files: files.map((f) => ({ name: f, lines: linesOf(readFileSync(join(dir, f), 'utf8')) })) });
  }
  return out;
}
