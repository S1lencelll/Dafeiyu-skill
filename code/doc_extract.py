#!/usr/bin/env python3
"""文档文本抽取：pdf / xlsx / xls / docx / csv / txt / md。
用法: doc_extract.py <文件路径> [--max-chars N]
stdout 输出纯文本（UTF-8），stderr 输出错误。
"""
import sys
import os
import subprocess
import json


def truncate(text: str, limit: int) -> str:
    if limit and len(text) > limit:
        return text[:limit] + f"\n…[截断，原长 {len(text)} 字符]"
    return text


def extract_pdf(path: str, limit: int) -> str:
    # 优先 pdftotext -layout：保留表格的列对齐，比 pypdf 可读
    try:
        out = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", path, "-"],
            capture_output=True, timeout=90,
        )
        if out.returncode == 0 and out.stdout.strip():
            return truncate(out.stdout.decode("utf-8", "replace"), limit)
    except Exception:
        pass
    # 兜底 pypdf
    try:
        from pypdf import PdfReader
        reader = PdfReader(path)
        pages = []
        for i, page in enumerate(reader.pages, 1):
            try:
                pages.append(f"--- 第 {i} 页 ---\n{page.extract_text() or ''}")
            except Exception:
                pages.append(f"--- 第 {i} 页 ---\n(提取失败)")
            if limit and sum(len(p) for p in pages) > limit * 1.5:
                break
        meta = f"[PDF {len(reader.pages)} 页]"
        return truncate(meta + "\n\n" + "\n\n".join(pages), limit)
    except Exception as e:
        raise RuntimeError(f"PDF 解析失败: {e}")


def extract_xlsx(path: str, limit: int) -> str:
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    chunks = [f"[XLSX {len(wb.sheetnames)} 个工作表: {', '.join(wb.sheetnames)}]"]
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            if row is None or all(c is None or str(c).strip() == "" for c in row):
                continue
            rows.append("\t".join("" if c is None else str(c) for c in row))
            if len(rows) >= 200:
                rows.append("…（本表只取前 200 行）")
                break
        chunks.append(f"\n=== 工作表: {ws.title}（{ws.max_row} 行 × {ws.max_column} 列）===\n" + "\n".join(rows))
        if limit and sum(len(c) for c in chunks) > limit * 1.5:
            break
    try:
        wb.close()
    except Exception:
        pass
    return truncate("\n".join(chunks), limit)


def extract_xls(path: str, limit: int) -> str:
    import xlrd
    book = xlrd.open_workbook(path)
    chunks = [f"[XLS {book.nsheets} 个工作表: {', '.join(book.sheet_names())}]"]
    for sh in book.sheets():
        rows = []
        for r in range(min(sh.nrows, 200)):
            values = [sh.cell_value(r, c) for c in range(sh.ncols)]
            if all(str(v).strip() == "" for v in values):
                continue
            rows.append("\t".join(str(v) for v in values))
        chunks.append(f"\n=== 工作表: {sh.name}（{sh.nrows} 行 × {sh.ncols} 列）===\n" + "\n".join(rows))
        if limit and sum(len(c) for c in chunks) > limit * 1.5:
            break
    return truncate("\n".join(chunks), limit)


def extract_docx(path: str, limit: int) -> str:
    import docx
    doc = docx.Document(path)
    parts = [f"[DOCX 段落 {len(doc.paragraphs)}，表格 {len(doc.tables)}]"]
    for p in doc.paragraphs:
        t = (p.text or "").strip()
        if t:
            parts.append(t)
        if limit and sum(len(x) for x in parts) > limit * 1.5:
            break
    for ti, table in enumerate(doc.tables, 1):
        rows = []
        for row in table.rows[:100]:
            rows.append("\t".join(c.text.strip() for c in row.cells))
        parts.append(f"\n=== 表格 {ti}（{len(table.rows)} 行）===\n" + "\n".join(rows))
        if limit and sum(len(x) for x in parts) > limit * 1.5:
            break
    return truncate("\n".join(parts), limit)


def read_text_auto(path: str):
    """猜编码：按 BOM 优先，然后逐个候选解码，坏字符最少的胜出。
    中文 txt 常见 UTF-8 / GB18030，偶尔 UTF-16。
    注意：文件被截断时末尾可能断在多字节字符中间，所以不能只靠「严格解码试通」，
    要允许少量坏字符并按坏字符数量打分。"""
    with open(path, "rb") as f:
        raw = f.read()

    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", "replace"), "utf-16"
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig", "replace"), "utf-8-sig"
    # 没有 BOM 但大量 \x00，基本是 UTF-16LE
    if raw[:400].count(b"\x00") > len(raw[:400]) // 3:
        return raw.decode("utf-16", "replace"), "utf-16"

    best = None
    for enc in ("utf-8", "gb18030", "big5"):
        try:
            txt = raw.decode(enc, "replace")
        except Exception:
            continue
        bad = txt.count("\ufffd")
        if best is None or bad < best[0]:
            best = (bad, enc, txt)
        if bad == 0:
            break

    if best is None:
        return raw.decode("utf-8", "replace"), "utf-8(有损)"
    return best[2], best[1]


def extract_text(path: str, limit: int) -> str:
    text, _enc = read_text_auto(path)
    return truncate(text, limit)




def clean_markdown(text: str) -> str:
    """把 markdown 转成适合模型读的纯文本：保留结构，去掉噪音标记。"""
    import re

    out = []
    in_code = False
    for line in text.split("\n"):
        s = line.rstrip()
        if re.match(r"^\s*```", s):
            in_code = not in_code
            continue
        if in_code:
            out.append("    " + s)          # 代码块整体缩进
            continue
        # 标题：保留层级感
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            level = len(m.group(1))
            out.append(("#" * level + " " + m.group(2).strip()) if level > 1 else m.group(2).strip())
            out.append("")
            continue
        # 图片：留 alt 文字
        s = re.sub(r"!\[([^\]]*)\]\([^)]+\)", lambda x: f"[图:{x.group(1) or '无说明'}]", s)
        # 链接：[文字](url) → 文字(url)
        s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1(\2)", s)
        # 粗体/斜体/删除线标记去掉
        s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
        s = re.sub(r"__(.+?)__", r"\1", s)
        s = re.sub(r"\*(.+?)\*", r"\1", s)
        s = re.sub(r"(?<![\w])\_(.+?)\_(?![\w])", r"\1", s)
        s = re.sub(r"~~(.+?)~~", r"\1", s)
        # 行内代码保留内容
        s = re.sub(r"`([^`]+)`", r"\1", s)
        # 表格分隔行
        if re.match(r"^\s*\|?[\s:-]+\|[\s:|-]*$", s):
            continue
        # 表格竖线 → 空格
        if s.strip().startswith("|"):
            s = " | ".join(x.strip() for x in s.strip().strip("|").split("|") if x.strip() != "---")
        # 引用块
        s = re.sub(r"^\s*>\s?", "", s)
        # 分隔线
        if re.match(r"^\s*([-*_]\s*){3,}$", s):
            continue
        out.append(s)
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def main():
    if len(sys.argv) < 2:
        print("usage: doc_extract.py <path> [--max-chars N]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    limit = 20000
    if "--max-chars" in sys.argv:
        try:
            limit = int(sys.argv[sys.argv.index("--max-chars") + 1])
        except Exception:
            pass
    if not os.path.exists(path):
        print(f"文件不存在: {path}", file=sys.stderr)
        return 2

    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".md", ".markdown"):
            text, _enc = read_text_auto(path)
            print(clean_markdown(text)[:limit])
            return 0
        if ext in (".txt", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".toml", ".ini"):
            text, enc = read_text_auto(path)
            text = text.replace("\r\n", "\n").replace("\r", "\n")
            print(truncate(text, limit))
            return 0
        if ext == ".pdf":
            text = extract_pdf(path, limit)
        elif ext == ".xlsx":
            text = extract_xlsx(path, limit)
        elif ext == ".xls":
            text = extract_xls(path, limit)
        elif ext == ".docx":
            text = extract_docx(path, limit)
        else:
            print(f"不支持的扩展名: {ext}", file=sys.stderr)
            return 3
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
