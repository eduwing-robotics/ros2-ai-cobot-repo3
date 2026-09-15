# 어댑터 선택 — env TB_ADAPTER=mock|real (기본 mock). 교체는 env 하나다 (D30).
import os


def make_adapter(robot_ids, on_log):
    kind = os.environ.get("TB_ADAPTER", "mock")
    if kind == "real":
        from .real import RealAdapter
        return RealAdapter(robot_ids, on_log), kind
    from .mock import MockAdapter
    return MockAdapter(robot_ids, on_log), "mock"
