"""평문 `def test_...` 함수를 `unittest` 가 걷게 한다 — **의존성 0.**

## 왜 (2026-09-04 · 게이트가 초록으로 거짓말하고 있었다)

`test_follow.py`(22건)·`test_amr.py`(9건)는 pytest 문법(평문 함수)으로 쓰였는데 게이트는
`python -m unittest discover` 를 돈다. unittest 는 **`TestCase` 하위 클래스만** 걷는다 —
평문 함수는 조용히 건너뛴다. 그래서 **31건이 한 번도 안 돌았고**, 게이트는 나머지를 세어
`Ran 246 · OK` 를 찍었다. **아무도 「내 시험이 안 돈다」를 물을 이유가 없었다.**

⛔ **「0건 통과」는 통과가 아니다** — 「막혀서 빈 것」과 「원래 없어서 빈 것」을 안 가른
전형이다. 여기서는 **개수를 세는 것**이 그 갈라내기다.

## 왜 pytest 를 안 깔았나

게이트가 *"표준 라이브러리 unittest 만 쓴다 — 새 의존성 0"* 이라고 스스로 적어 뒀다.
그 약속을 깨는 것보다 **9줄**이 싸다. 시험 파일을 `TestCase` 로 다시 쓰는 길도 있었지만
그건 31건을 통째로 손대는 일이라, 고치는 김에 뜻이 바뀌는 사고를 부른다.

    # 시험 파일 끝에 두 줄
    from _plaintests import load_tests_for
    def load_tests(loader, tests, pattern): return load_tests_for(__name__)
"""
import inspect
import sys
import tempfile
import unittest
from pathlib import Path


def _wrap(fn):
    """pytest 의 `tmp_path` 만 채워 준다 — **그 하나가 실제로 쓰이는 전부다.**

    ⛔ 픽스처 흉내를 넓히지 않는다. 여기가 자라기 시작하면 결국 pytest 를 다시 짜게 되고,
    그때는 그냥 pytest 를 깔면 된다. 지금은 인자 하나라서 9줄이 싼 것뿐이다.
    """
    params = list(inspect.signature(fn).parameters)
    if not params:
        return fn
    if params != ["tmp_path"]:
        raise AssertionError(f"{fn.__name__} 이 모르는 픽스처를 쓴다 — {params}")

    def run():
        with tempfile.TemporaryDirectory() as d:
            fn(Path(d))
    run.__name__ = fn.__name__
    return run


def load_tests_for(module_name):
    """그 모듈의 `test_*` 평문 함수를 전부 담은 스위트. **하나도 없으면 소리 내어 실패한다.**"""
    mod = sys.modules[module_name]
    suite = unittest.TestSuite()
    for name in sorted(vars(mod)):
        fn = getattr(mod, name)
        if name.startswith("test_") and callable(fn) and getattr(fn, "__module__", "") == module_name:
            suite.addTest(unittest.FunctionTestCase(_wrap(fn), description=f"{module_name}.{name}"))
    if not suite.countTestCases():
        # 파일 이름이 `test_` 인데 걷힌 게 0 이면 **이 배선이 고장 난 것**이다.
        # 조용히 0 을 내면 이 파일이 막으려던 바로 그 상태로 되돌아간다.
        raise AssertionError(f"{module_name} 에서 걷힌 시험이 0 건이다 — 배선이 끊겼다")
    return suite
