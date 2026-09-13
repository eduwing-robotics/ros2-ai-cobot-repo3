#!/usr/bin/env python3
"""LEADME 의 .md 를 기존 .txt 형식(제목 배너 + 인용 파이프)으로 변환한다."""
import re, sys, pathlib

def conv(md: str) -> str:
    out, in_code = [], False
    for ln in md.splitlines():
        if ln.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            out.append("  " + ln if ln else "")
            continue
        if ln.startswith("# "):
            t = ln[2:].strip()
            out += ["=" * 70, t, "=" * 70]
        elif ln.startswith("## "):
            t = ln[3:].strip()
            out += ["", "-" * 70, t, "-" * 70]
        elif ln.startswith("### "):
            t = ln[4:].strip()
            out += ["", "[ " + t + " ]"]
        elif ln.startswith("> "):
            out.append("  | " + ln[2:].strip())
        elif ln.startswith("|"):
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                continue
            out.append("  " + " | ".join(cells))
        elif ln.startswith("---"):
            out.append("")
        else:
            out.append(ln)
    txt = "\n".join(out)
    txt = re.sub(r"\*\*(.+?)\*\*", r"\1", txt)
    txt = re.sub(r"`(.+?)`", r"\1", txt)
    txt = re.sub(r"~~(.+?)~~", r"\1", txt)
    txt = re.sub(r"\n{4,}", "\n\n\n", txt)
    return txt + "\n"

for f in sys.argv[1:]:
    src = pathlib.Path(f)
    dst = src.with_suffix(".txt")
    dst.write_text(conv(src.read_text()), encoding="utf-8")
    print(f"{src.name} -> {dst.name}  ({len(dst.read_text().splitlines())}줄)")
