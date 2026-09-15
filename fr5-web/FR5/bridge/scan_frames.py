"""`/scan` HUD용 JPEG 정지화면 최근 몇 장만 메모리에 둔다."""
from collections import OrderedDict
from secrets import token_urlsafe
from threading import Lock

MAX_FRAMES = 4
_frames = OrderedDict()
_lock = Lock()


def add(jpeg, width_px, height_px, captured_at):
    """JPEG를 보관하고 JSON에 싣을 작은 참조만 돌려준다."""
    if not isinstance(jpeg, bytes) or not jpeg or width_px <= 0 or height_px <= 0:
        return None
    frame_id = token_urlsafe(12)
    with _lock:
        _frames[frame_id] = jpeg
        while len(_frames) > MAX_FRAMES:
            _frames.popitem(last=False)
    return {"url": f"/scan/frame/{frame_id}", "widthPx": int(width_px),
            "heightPx": int(height_px), "capturedAt": float(captured_at)}


def get(frame_id):
    """없거나 최근 4장 밖으로 밀려났으면 `None`. 수명을 늘리지 않는다."""
    with _lock:
        return _frames.get(frame_id)
