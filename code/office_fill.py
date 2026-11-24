#!/usr/bin/env python3
"""Word / Excel 模板无损填表（office_template_filler 的 python 层）。

stdin 收 JSON：
  {"mode":"inspect","path":"/path/tpl.docx"}
  {"mode":"fill","path":"/path/tpl.docx","mappings":{"name":"张三","date":"2026-11-23"},"output":"/path/out.docx"}

Excel 的 mappings 支持三种键：
  "Sheet1!B3"   → 指定工作表某格
  "B3"          → 活动工作表的某格
  "{{name}}"    → 任意单元格文本里的占位符（docx/xlsx 都支持）

stdout 一行 JSON：{"ok":true, ...} / {"ok":false,"error":"..."}
"""
import json
import os
import re
import sys

PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]{1,40}?)\s*\}\}")


def die(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:400]}, ensure_ascii=False))
    sys.exit(1)


def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx":
        return "docx"
    if ext in (".xlsx", ".xlsm"):
        return "xlsx"
    raise ValueError(f"只支持 .docx / .xlsx，收到 {ext or '无后缀'}")


# ── docx ──────────────────────────────────────────────────────────────────────
def inspect_docx(path):
    import docx
    d = docx.Document(path)
    paras = [p.text.strip() for p in d.paragraphs if p.text.strip()]
    tokens = set()
    for t in paras:
        tokens.update(PLACEHOLDER_RE.findall(t))
    tables = []
    for ti, tb in enumerate(d.tables):
        rows = []
        for r in tb.rows[:5]:
            rows.append([c.text.strip()[:24] for c in r.cells][:12])
        for r in rows:
            for c in r:
                tokens.update(PLACEHOLDER_RE.findall(c))
        tables.append({"index": ti, "rows": len(tb.rows), "cols": len(tb.columns), "head": rows})
    return {
        "kind": "docx",
        "paragraphs": paras[:40],
        "paragraphCount": len(paras),
        "tables": tables[:10],
        "placeholders": sorted(tokens)[:40],
    }


def _replace_in_paragraph(p, mapping, counter):
    """整段替换占位符；保留段落样式，run 级样式退化为首 run 的样式。"""
    text = p.text
    if "{{" not in text:
        return False
    new = text
    for k, v in mapping.items():
        token = "{{%s}}" % k
        if token in new:
            new = new.replace(token, str(v))
            counter[0] += 1
    # 兼容 {{ k }} 带空格写法
    def _sub(m):
        key = m.group(1).strip()
        if key in mapping:
            counter[0] += 1
            return str(mapping[key])
        return m.group(0)
    new = PLACEHOLDER_RE.sub(_sub, new)
    if new == text:
        return False
    if p.runs:
        p.runs[0].text = new
        for r in p.runs[1:]:
            r.text = ""
    else:
        p.add_run(new)
    return True


def fill_docx(path, mapping, output):
    import docx
    d = docx.Document(path)
    counter = [0]
    for p in d.paragraphs:
        _replace_in_paragraph(p, mapping, counter)
    for tb in d.tables:
        for row in tb.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    _replace_in_paragraph(p, mapping, counter)
    d.save(output)
    return {"filled": counter[0]}


# ── xlsx ──────────────────────────────────────────────────────────────────────
def inspect_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=False)
    sheets = []
    tokens = set()
    for ws in wb.worksheets[:8]:
        head = []
        for row in ws.iter_rows(min_row=1, max_row=min(4, ws.max_row or 1), values_only=True):
            head.append(["" if v is None else str(v)[:24] for v in list(row)[:10]])
            for v in row:
                if isinstance(v, str):
                    tokens.update(PLACEHOLDER_RE.findall(v))
        sheets.append({
            "name": ws.title,
            "rows": ws.max_row,
            "cols": ws.max_column,
            "head": head,
        })
    return {
        "kind": "xlsx",
        "sheets": sheets,
        "placeholders": sorted(tokens)[:40],
        "hint": '填充时 mappings 可用 "Sheet名!单元格" 指定位置，例如 {"Sheet1!B3":"张三"}',
    }


def fill_xlsx(path, mapping, output):
    import openpyxl
    wb = openpyxl.load_workbook(path)
    filled = 0
    leftover = dict(mapping)

    # 1) 占位符替换（任意单元格文本）
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if not isinstance(cell.value, str) or "{{" not in cell.value:
                    continue
                new = cell.value
                for k, v in list(leftover.items()):
                    token = "{{%s}}" % k
                    if token in new:
                        new = new.replace(token, str(v))
                        leftover.pop(k, None)
                        filled += 1
                new = PLACEHOLDER_RE.sub(
                    lambda m: str(leftover.pop(m.group(1).strip(), m.group(0))),
                    new,
                )
                if new != cell.value:
                    cell.value = new

    # 2) 按坐标写值（保留样式与公式）
    for key, val in list(leftover.items()):
        if "!" in key:
            sheet_name, coord = key.split("!", 1)
        else:
            sheet_name, coord = None, key
        coord = coord.strip().upper()
        if not re.match(r"^[A-Z]{1,3}\d{1,6}$", coord):
            continue  # 不是坐标，跳过（留给占位符阶段处理）
        ws = wb[sheet_name] if (sheet_name and sheet_name in wb.sheetnames) else wb.active
        try:
            ws[coord] = val
            filled += 1
            leftover.pop(key, None)
        except Exception:
            pass

    wb.save(output)
    return {"filled": filled, "unused": sorted(leftover.keys())[:10]}


def main():
    spec_path = None
    if "--spec" in sys.argv:
        i = sys.argv.index("--spec")
        spec_path = sys.argv[i + 1] if i + 1 < len(sys.argv) else None
    try:
        raw = open(spec_path, encoding="utf-8").read() if spec_path else sys.stdin.read()
        spec = json.loads(raw or "{}")
    except Exception as e:
        die(f"spec 不是合法 JSON: {e}")

    mode = str(spec.get("mode") or "inspect").lower()
    path = str(spec.get("path") or "").strip()
    if not path or not os.path.exists(path):
        die(f"文件不存在：{path or '（未提供 path）'}")

    try:
        kind = kind_of(path)
    except Exception as e:
        die(e)

    try:
        if mode == "inspect":
            data = inspect_docx(path) if kind == "docx" else inspect_xlsx(path)
            data["ok"] = True
            print(json.dumps(data, ensure_ascii=False))
            return

        if mode == "fill":
            mapping = spec.get("mappings") or {}
            if not isinstance(mapping, dict) or not mapping:
                die("mode=fill 需要 mappings（对象）")
            output = str(spec.get("output") or "").strip()
            if not output:
                stem, ext = os.path.splitext(path)
                output = f"{stem}-filled{ext}"
            os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
            res = fill_docx(path, mapping, output) if kind == "docx" else fill_xlsx(path, mapping, output)
            res.update({"ok": True, "kind": kind, "path": output, "bytes": os.path.getsize(output)})
            print(json.dumps(res, ensure_ascii=False))
            return

        die(f"mode 只支持 inspect / fill，收到 {mode}")
    except Exception as e:
        die(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
