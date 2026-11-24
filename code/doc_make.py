#!/usr/bin/env python3
"""生成 xlsx：从 stdin 读 JSON，写到一个 xlsx 文件。
stdin: {"sheet": "Sheet1", "rows": [["月份","金额"],["1月",1200]]}
用法: doc_make.py <输出路径>
"""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Font


def main():
    if len(sys.argv) < 2:
        print("usage: doc_make.py <out.xlsx>", file=sys.stderr)
        return 2
    out = sys.argv[1]
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(f"stdin 不是合法 JSON: {e}", file=sys.stderr)
        return 2

    rows = payload.get("rows") or []
    if not isinstance(rows, list) or not rows:
        print("rows 不能为空", file=sys.stderr)
        return 2
    sheet = str(payload.get("sheet") or "Sheet1")[:31]

    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    for r in rows:
        ws.append(list(r) if isinstance(r, (list, tuple)) else [r])
    # 首行加粗 + 冻结 + 简单列宽
    if ws.max_row >= 1:
        for cell in ws[1]:
            cell.font = Font(bold=True)
        ws.freeze_panes = "A2"
    for col in ws.columns:
        width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
        ws.column_dimensions[col[0].column_letter].width = min(40, max(8, width + 2))
    wb.save(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
