# 어댑터 선택 — 프로필의 adapter 필드가 정한다 (config.yaml). 교체는 프로필 한 줄이다.
from .fairino import FairinoAdapter
from .mock import MockFr5Adapter


def make_adapter(profile):
    kind = profile.get("adapter", "mock")
    if kind == "fairino":
        return FairinoAdapter(profile)
    return MockFr5Adapter(profile)
