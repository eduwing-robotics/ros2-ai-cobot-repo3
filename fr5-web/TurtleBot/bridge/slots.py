# 스크립트 슬롯 — slots/*.py 폴더 스캔이 목록이다. 파일을 넣으면 슬롯이 생긴다 (TB-CONTRACT).
import ast
from pathlib import Path

SLOTS_DIR = Path(__file__).parent / "slots"


def list_slots():
    slots = []
    for f in sorted(SLOTS_DIR.glob("*.py")):
        if f.name.startswith("."):
            continue                 # macOS AppleDouble(._*) 등 숨김파일은 슬롯이 아니다
        try:
            doc = ast.get_docstring(ast.parse(f.read_text(encoding="utf-8"))) or ""
        except SyntaxError:
            doc = "(문법 오류 — 실행하면 즉시 error 로 끝난다)"
        slots.append({"name": f.stem, "description": doc.splitlines()[0] if doc else ""})
    return slots


def slot_file(name):
    f = SLOTS_DIR / f"{name}.py"
    return f if f.exists() else None
