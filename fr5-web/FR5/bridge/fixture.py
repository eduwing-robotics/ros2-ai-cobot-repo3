"""움직이는 장애물 — **비전이 자리만 준다** (계약 §움직이는 장애물 · D130).

받침(거치대)은 자주 옮겨진다. 프로필에 박으면 옮길 때마다 사람이 고쳐야 하고, 안 고치면
게이트가 **빈 자리를 막고 진짜 받침은 안 막는다.** 둘째가 위험하다. 받침에는 태그가 붙어
있으므로 자리는 카메라가 말할 수 있다 (`scripts/map/fixture-pose.py`).

## ⛔ 이 모듈이 지키는 것은 하나 — **비전이 보호를 줄이지 못한다**

- **추가와 이동만 한다. 삭제는 없다.** 태그를 못 보면 산출 파일이 마지막 자리를 그대로
  두고 `staleReason` 만 붙인다 — 여기서는 그걸 그대로 실어 나른다. 게이트는 계속 막는다
- **크기·높이는 비전이 안 준다.** 파일의 `halfMm`·`heightMm` 는 그쪽 상수이고, 여기서는
  **범위 검사만** 한다 — 터무니없으면 안 쓴다
- **값이 깨졌으면 상자를 안 만들고 이유를 노출한다.** 없는 장애물을 지어내지 않되,
  **못 만들었다는 사실이 조용히 사라지지 않게** `/state` 에 싣는다

## 왜 파일을 매번 안 읽나

`/state` 는 27Hz 로 나간다. 그 주기로 디스크를 때리지 않는다 — **mtime 이 바뀔 때만** 다시
읽는다. 산출기는 1Hz 로 쓰므로 이 캐시가 값을 늦추지 않는다.
"""
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

# 값이 이 범위를 벗어나면 **파일이 깨진 것**으로 본다. 비전이 크기를 정하지 못하게 하는
# 두 번째 자물쇠다 — 산출기 상수가 실수로 바뀌어도 게이트가 통째로 이상해지지 않는다
HALF_MM_RANGE = (20.0, 400.0)
# 태그 중심 → 윗면 거리. **음수도 허용한다** — 태그가 윗면보다 위에 붙는 받침이 있을 수 있다.
# 범위는 「사람이 자로 잰 값이 이 밖이면 오타다」 정도의 그물이다
TO_TOP_MM_RANGE = (-300.0, 300.0)
# 이보다 오래 갱신이 없으면 **산출기가 멎은 것**이다. 자리는 유지하되 그 사실을 말한다 —
# 값을 믿는 근거는 값이 아니라 **값의 나이**다 (`watch-calib.py` 머리말과 같은 규약)
STALE_AFTER_S = 30.0
# ⛔ **비전이 물리적으로 불가능한 자리를 주면 안 된다** (2026-08-13 실측 사고).
# 다른 세션이 5분 간격 두 표본에서 **600mm 떨어진 값**을 봤다 — z 가 `-354 → -31` 로
# 323mm 올라갔는데, 받침이 작업대 위에 있다면 **그 높이는 있을 수 없다.**
# 점프 가드(1틱 400mm)는 이걸 못 막는다 — **25mm 씩 걸어가면 어디로든 간다.**
# 그래서 「한 걸음의 크기」가 아니라 **「있을 수 있는 자리인가」**로 막는다.
# 받침은 작업대 상자 위에 놓인다. 그 상자에서 이만큼 벗어나면 **안 쓴다.**
ON_TABLE_XY_MM = 300.0    # 작업대 가장자리에서 이만큼까지는 허용 (일부만 걸쳐도 받는다)
ON_TABLE_Z_MM = 250.0     # 상판 높이에서 위아래로 이만큼. 들어올리면 그건 「놓인 것」이 아니다

# **경로마다 따로 기억한다** (2026-08-28). 예전엔 칸이 하나여서 두 번째 파일을 읽는 순간
# 첫 파일의 mtime 을 덮어썼다 — 그러면 두 파일을 번갈아 읽을 때 **매번 디스크를 다시 타고**,
# 더 나쁘게는 한쪽이 못 읽힐 때 다른 쪽의 마지막 성공값을 물려받는다. 받침 하나만 읽던
# 동안에는 안 드러났고, 터틀봇 자리(`amr-pose.json`)가 두 번째 손님으로 오면서 드러났다.
_cache = {}


def _read(path):
    """mtime 이 바뀔 때만 다시 읽는다. 못 읽으면 `None` — 그건 「그 파일 없음」이다."""
    key = str(path)
    slot = _cache.setdefault(key, {"mtime": None, "doc": None})
    try:
        m = os.path.getmtime(path)
    except OSError:
        slot["mtime"], slot["doc"] = None, None
        return None
    if slot["mtime"] != m:
        try:
            with open(path, encoding="utf-8") as f:
                slot["doc"] = json.load(f)
            slot["mtime"] = m
        except (OSError, ValueError):
            # 반쯤 쓰인 파일을 읽었을 수 있다 — 산출기는 원자적으로 쓰지만 방어한다.
            # **마지막 성공값을 버리지 않는다** (지우지 않는다는 규약)
            pass
    return slot["doc"]


def on_table(center_mm, boxes):
    """받침이 **작업대 위에 있을 수 있는 자리인가.** 아니면 `(False, 사유)`.

    ⛔ 점프 가드는 「한 걸음의 크기」만 본다 — **작게 여러 번 걸으면 어디로든 간다.**
    이 검사는 「걸어온 거리」가 아니라 **「지금 있는 자리가 말이 되나」**를 본다.
    실측(2026-08-13): 받침 z 가 상판 위 368mm 로 올라간 표본이 나왔는데, 작업대에 놓인
    물건에는 있을 수 없는 높이다. 기준은 **프로필 상자**다 — 비전이 아니라 사람이 잰 값이다.
    """
    tables = [b for b in (boxes or []) if b.get("source", "profile") == "profile"]
    if not tables:
        return True, None                # 기준이 없으면 판정하지 않는다 (막지도 않는다)
    x, y, z = center_mm
    for b in tables:
        try:
            x0, x1 = sorted(b["xMm"]); y0, y1 = sorted(b["yMm"]); top = b["topZMm"]
        except (KeyError, TypeError, ValueError):
            continue
        if (x0 - ON_TABLE_XY_MM <= x <= x1 + ON_TABLE_XY_MM
                and y0 - ON_TABLE_XY_MM <= y <= y1 + ON_TABLE_XY_MM
                and abs(z - top) <= ON_TABLE_Z_MM):
            return True, None
    return False, (f"받침이 있을 수 없는 자리다 — ({x:.0f}, {y:.0f}, {z:.0f}) "
                   "은 어느 상판 위도 아니다")


def box_from(path, now=None, tables=None):
    """산출 파일 → `workspace.boxes` 한 줄. 없으면 `(None, None)`.

    @param tables 프로필 상자들. 주면 **자리 타당성**까지 본다 (위 `on_table`).
    @returns `(box|None, note|None)` — `note` 는 **못 만든 이유**다. 조용히 사라지면 안 된다.
    """
    doc = _read(path)
    if doc is None:
        return None, None                     # 파일이 없다 = 받침을 안 쓴다. 경고가 아니다

    c = doc.get("centerMm")
    half = doc.get("halfMm")
    # ⛔ **`heightMm/2` 가정을 버렸다** (2026-08-13). 예전엔 「태그가 옆면 정중앙」이라 보고
    # 높이의 절반을 올렸는데, 그건 **정육면체에 태그를 가운데 붙였을 때만** 참이다.
    # 이제 산출기가 **태그 중심 → 윗면 거리**를 그대로 싣는다 (`tags.json` 에서 온 값).
    # 옛 파일에는 그 칸이 없으므로 **거부한다** — 옛 가정으로 계속 도는 것보다 낫다.
    to_top = doc.get("tagCenterToTopMm")
    if not (isinstance(c, list) and len(c) == 3 and all(isinstance(v, (int, float)) for v in c)):
        return None, "받침 자리가 깨졌다 — centerMm 이 3개 수가 아니다"
    if not (isinstance(half, (int, float)) and HALF_MM_RANGE[0] <= half <= HALF_MM_RANGE[1]):
        return None, f"받침 크기가 범위 밖이다 — halfMm={half}"
    if not (isinstance(to_top, (int, float)) and TO_TOP_MM_RANGE[0] <= to_top <= TO_TOP_MM_RANGE[1]):
        return None, ("받침 윗면 거리가 없거나 범위 밖이다 — "
                      f"tagCenterToTopMm={to_top} (옛 `heightMm` 파일이면 다시 산출한다)")

    if tables is not None:
        ok, why = on_table(c, tables)
        if not ok:
            return None, why

    now = time.time() if now is None else now
    # 산출기가 붙인 사유를 **그대로 실어 나른다** — 두 말을 만들지 않는다
    stale = doc.get("staleReason")
    checked = doc.get("checkedAt")
    if not stale and isinstance(checked, (int, float)) and now - checked > STALE_AFTER_S:
        stale = f"받침 추적이 멎었다 — {now - checked:.0f}초 전 값"

    x, y, z = c
    return {
        "name": "받침",
        # ⚠ **z 는 태그 중심**이라 윗면이 아니다 — 태그가 옆면에 붙기 때문이다.
        # 윗면까지의 거리는 **사람이 자로 재서** `tags.json` 에 적는다 (코드가 추측하지 않는다).
        # 정밀한 파지 기준면으로는 쓰지 않는다 (계약 §천장 · 사슬 오차 23mm)
        "xMm": [x - half, x + half],
        "yMm": [y - half, y + half],
        # 윗면 = 태그 중심 + (태그→윗면). **가정이 아니라 잰 값이다**
        "topZMm": z + to_top,
        "marginMm": 10,
        "source": "vision",
        **({"staleReason": stale} if stale else {}),
    }, None



# ── 솔브 — **여기가 정본이다.** `scripts/map/fixture-pose.py` 가 이걸 import 한다.
# 사본을 두면 CLI 로 잰 값과 브리지가 잰 값이 갈리고, 그때 어느 쪽이 진짜인지 못 가른다.
# ⛔ **받침 기하를 여기 상수로 두지 않는다** (2026-08-13 · 실물 사진으로 드러남).
# 예전엔 `HEIGHT_MM = 86.5`(종이상자)를 들고 **「태그는 옆면 정중앙」**을 가정해
# `topZMm = z + 높이/2` 로 썼다. 실물은 **나무 정육면체**였고, 무엇보다 **받침이 바뀌면
# 그 두 가정이 조용히 틀린다** — 화면도 게이트도 아무 말을 안 한다.
# 이제 받침마다 `tags.json` §fixtureTags 에 적고, **없으면 안 쓴다**(추측 금지 · 제1원칙).
JUMP_MM = 400.0       # 사람이 1초에 이보다 멀리 못 옮긴다
JUMP_ACCEPT_AFTER = 3 # ⛔ 거부가 영원해지면 안 된다 — 이어지면 「진짜 옮긴 것」으로 받는다
TIMEOUT_S = 4.0



def _pick(spec, tag_id):
    """`fixtureTags` 에서 **id 로** 고른다 — 맨 앞을 집지 않는다 (2026-08-27 · D149).

    ⛔ **`[0]` 은 지뢰였다.** 목록이 1 → 9 로 늘면서 맨 앞(`id6` · 나무 정육면체)이 남았는데
    그 물건은 08-18 이후 없다. 08-18 P1 이 *"누가 순서를 바꾸면 게이트가 **다른 물건의
    기하**로 받침을 세운다"* 고 예고했고, 08-27 에 그 앞 항목이 사라져 `noTag` 로 났다.
    ⚠ 더 나쁜 쪽은 **`id6` 을 목록에서 지우는 것**이었다 — 그러면 `[0]` 이 **작업대1 태그**가
    되어 게이트가 작업대 기하로 받침을 세운다. **막는 자리가 틀린 채 초록**이 된다.

    `tag_id` 가 없으면 **안 쓴다** — 추측하지 않는다(제1원칙).
    """
    if tag_id is None:
        return None
    for ft in spec.get("fixtureTags") or []:
        if int(ft.get("id", -1)) == int(tag_id):
            return ft
    return None


def solve_tag(host, spec, I, K, dist, tag_id):
    """프레임 한 장에서 받침 태그를 풀어 **카메라 기준** 자세를 준다.

    ⚠ `cv2`·`numpy` 를 **함수 안에서** 늦게 임포트한다 — 모듈 최상단에 두면 cv2 가 없는
    기계에서 `import fixture` 가 터져 **브리지가 통째로 안 뜬다.** 비전이 브리지를 죽이면
    안 된다는 이 모듈의 규약이 임포트에도 적용된다 (2026-08-13).
    """
    import cv2
    import numpy as np
    try:
        with urllib.request.urlopen(f"http://{host}/shot.jpg", timeout=TIMEOUT_S) as r:
            buf = np.frombuffer(r.read(), np.uint8)
    except Exception as e:                                  # noqa: BLE001
        return None, f"noFrame ({str(e)[:40]})"
    g = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    if g is None:
        return None, "noFrame (디코드 실패)"
    if (g.shape[1], g.shape[0]) != (I["widthPx"], I["heightPx"]):
        # 해상도가 다르면 내부 파라미터가 안 맞는다 — **스케일로 메우지 않는다** (D64)
        return None, f"resolution ({g.shape[1]}x{g.shape[0]})"

    ft = _pick(spec, tag_id)
    if not ft:
        return None, f"받침 태그 id{tag_id} 가 tags.json 에 없다"
    tid, size = int(ft["id"]), float(ft.get("tagSizeMm", 70))
    # ⚠ **인쇄 배율을 반영한 실측 한 변을 쓴다.** 선언 70mm 로 풀었더니 215.8mm 어긋났고
    # 실측 58.8mm 로 풀자 23.0mm 가 됐다 (`fixture-tag-chain.md`). `solvePnP` 는 태그 크기를
    # 그대로 거리로 환산하므로 **크기 오류가 깊이 오류로 그대로 나온다.**
    size = float(ft.get("measuredMm", size))

    dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_APRILTAG
    corners, ids, _ = cv2.aruco.ArucoDetector(dic, params).detectMarkers(g)
    if ids is None or tid not in [int(i) for i in ids.ravel()]:
        return None, f"noTag (id{tid} 안 보인다)"
    ip = [c for c, i in zip(corners, ids.ravel()) if int(i) == tid][0].reshape(4, 2)
    h = size / 2
    op = np.array([[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]], np.float64)
    ok, rv, tv = cv2.solvePnP(op, ip.astype(np.float64), K, dist,
                              flags=cv2.SOLVEPNP_IPPE_SQUARE)
    if not ok:
        return None, "solvePnP 실패"
    return tv.ravel(), None


def odom_to_lab(p_odom_xy, fit, z_mm):
    """터틀봇 바퀴 좌표(`odom`) → 태그 좌표(`lab`). **적용의 정본은 여기 한 곳이다** (하드 룰 5).

    계수(`fit`)는 `amr.py` 가 태그가 보인 순간의 쌍으로 **맞춘다**. 여기는 **쓰기만** 한다 —
    맞추는 자리와 쓰는 자리를 갈라 놓아야 산수가 두 벌이 안 된다.

    `z` 는 안 푼다 — 쌍이 평면(상판)에서만 나오므로 높이는 **태그가 준 값을 그대로 쓴다**
    (`z_mm`). 없는 자유도를 지어내지 않는다.

        p_lab = R(fit.yawDeg) · p_odom + (fit.txMm, fit.tyMm)
    """
    import numpy as np
    th = np.radians(float(fit["yawDeg"]))
    c, s = np.cos(th), np.sin(th)
    x, y = float(p_odom_xy[0]), float(p_odom_xy[1])
    return [c * x - s * y + float(fit["txMm"]), s * x + c * y + float(fit["tyMm"]), float(z_mm)]


def lab_to_user1(p_lab, base, user):
    """태그(lab) 기준 점 → 로봇 베이스 → user1. **환산의 정본은 여기 한 곳이다** (하드 룰 5).

    카메라에서 오는 쪽(`cam_to_user1`)과 이미 lab 인 쪽(터틀봇 자리 `amr-pose.json`)이
    **같은 산수를 두 벌 갖지 않게** 갈라 놓은 것이다. `robot-base-in-tag.json` 을 다시 잰 날
    한 곳만 고치면 둘 다 따라온다.
    """
    import numpy as np
    th = np.radians(base["yawDeg"])
    c, s = np.cos(th), np.sin(th)
    d = np.asarray(p_lab, float) - np.array([base["xMm"], base["yMm"], base["zMm"]], float)
    p_base = np.array([c * d[0] + s * d[1], -s * d[0] + c * d[1], d[2]])   # yaw 역회전
    return p_base - np.array(user[:3], float)     # base → user1 (회전 0 전제 · `toBase` 규약)


def cam_to_user1(p_cam, E, base, user):
    """카메라 기준 점 → 태그(lab) → 로봇 베이스 → user1. **네 칸을 한 곳에서 한다.**"""
    import cv2
    import numpy as np
    R, _ = cv2.Rodrigues(np.array(E["rvec"], float))
    p_lab = R.T @ (np.asarray(p_cam, float) - np.array(E["tvecMm"], float))
    return lab_to_user1(p_lab, base, user)


def fixture_geom(spec, tag_id):
    """받침 기하를 **데이터에서** 읽는다. 없으면 `(None, 사유)` — **추측하지 않는다.**

    필요한 것 둘 —
      `halfMm`            게이트 상자 반폭. 실물보다 크게 (넓게 막는 쪽)
      `tagCenterToTopMm`  태그 중심 → **받침 윗면**까지 수직 거리. 태그가 옆면이라
                          윗면을 못 보기 때문에 이 값이 없으면 막을 높이를 모른다
    """
    ft = _pick(spec, tag_id)
    if not ft:
        return None, f"받침 태그 id{tag_id} 정의가 없다 — tags.json §fixtureTags"
    half, to_top = ft.get("halfMm"), ft.get("tagCenterToTopMm")
    miss = [k for k, v in (("halfMm", half), ("tagCenterToTopMm", to_top))
            if not isinstance(v, (int, float))]
    if miss:
        # **받침이 바뀌면 여기서 멈춘다.** 옛 상수로 계속 도는 것보다 안 그리는 것이 낫다 —
        # 「그럴듯하게 틀린 자리를 막는 것」이 이 기능이 없애려던 바로 그 상태다
        return None, f"받침 기하가 없다 — tags.json 에 {'·'.join(miss)} 를 적어라"
    return {"id": int(ft.get("id", 6)),
            "sizeMm": float(ft.get("measuredMm", ft.get("tagSizeMm", 70))),
            "halfMm": float(half), "toTopMm": float(to_top)}, None


def _tick(cam_host, out_path, spec, cal, base, user, prev, streak, tag_id):
    """한 프레임. **무슨 일이 있어도 예외를 밖으로 안 낸다** (부르는 쪽도 감싼다)."""
    import cv2, numpy as np
    geom, why_g = fixture_geom(spec, tag_id)
    if geom is None:
        _tracker["note"] = why_g            # **조용히 옛 상수로 돌지 않는다**
        return prev, streak
    I, E = cal["intrinsics"], cal["labToCam"]
    K = np.array([[I["fx"], 0, I["cx"]], [0, I["fy"], I["cy"]], [0, 0, 1]])
    dist = np.array(I["dist"])
    p_cam, why = solve_tag(cam_host, spec, I, K, dist, tag_id)
    now = time.time()

    if p_cam is None:
        # ⛔ **지우지 않는다.** 마지막 자리를 두고 「못 봤다」만 갱신한다
        if prev:
            prev = {**prev, "checkedAt": now, "staleReason": f"태그를 못 본다 — {why}"}
            _write_atomic(out_path, prev)
        _tracker["note"] = None
        return prev, streak

    u = cam_to_user1(p_cam, E, base, user)
    jump = None if not (prev and prev.get("centerMm")) else \
        float(np.linalg.norm(u - np.array(prev["centerMm"], float)))

    if jump is not None and jump > JUMP_MM and streak < JUMP_ACCEPT_AFTER:
        # ⚠ **거부해도 반드시 쓴다** — 안 쓰면 `checkedAt` 이 안 늙어 「방금 확인함」인 척한다.
        # 2026-08-13 실측: 그래서 139초 동안 215mm 틀린 채 화면이 초록이었다
        streak += 1
        if prev:
            _write_atomic(out_path, {**prev, "checkedAt": now,
                "staleReason": f"큰 이동을 확인 중 — {jump:.0f}mm ({streak}/{JUMP_ACCEPT_AFTER})"})
        return prev, streak

    doc = {"_": "FR5/bridge/fixture.py 추적 산출물 — 직접 고치지 마라",
           "_프레임": "user1 (config.yaml workspace.boxes 와 같은 프레임)",
           "centerMm": [round(float(v), 1) for v in u],
           # 기하는 **데이터에서 온 값**이다 (`tags.json` §fixtureTags). 코드 상수가 아니다
           "halfMm": geom["halfMm"], "tagCenterToTopMm": geom["toTopMm"],
           "seenAt": now, "checkedAt": now, "basis": E.get("shot"),
           "jumpMm": None if jump is None else round(jump, 1)}
    _write_atomic(out_path, doc)
    _tracker["note"] = None
    return doc, 0


def _write_atomic(path, doc):
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)

# ══ 추적 — **브리지 안에서 돈다** (2026-08-13) ═══════════════════════════════════
#
# 왜 옮겼나: 옆에서 도는 프로세스를 세 번 세웠고 **세 번 다 조용히 죽었다** —
# ①점프 가드 래치업(파일이 「방금 확인함」인 척했다) ②`Start-Process` 가 PowerShell 의 `cd`
# 를 안 따라가 즉사 ③아예 안 뜸(stdout·stderr 둘 다 빔). 공통점은 **실패가 조용했다**는 것이다.
#
# 브리지 안에 두면 **생사가 하나**다 — 브리지가 살아 있으면 추적도 살아 있고, 브리지가 죽으면
# 화면이 통째로 안 떠서 **아무도 못 속는다.** 상주 등록·재시작·로그아웃 문제가 같이 사라진다.
#
# ⛔ **비전이 브리지를 죽이면 안 된다.** 루프 전체를 감싸 예외를 먹고, 못 풀면 마지막 값을
# 그대로 둔다 (이 모듈의 규약과 같다). 카메라가 없거나 cv2 가 없으면 **조용히 안 돈다** —
# 그건 「받침을 안 쓴다」이고 고장이 아니다.
_tracker = {"thread": None, "note": None}


def tracker_note():
    """추적기가 왜 안 도는지 — `/state` 가 이걸 싣는다. **조용히 사라지지 않게.**"""
    return _tracker["note"]


def start_tracker(cam_host, out_path, spec_path, calib_path, base_path, user_getter,
                  period_s=1.0, tag_id=None):
    """받침 추적을 **브리지 프로세스 안에서** 상주시킨다. 실패해도 브리지를 안 죽인다.

    ⛔ **`tag_id` 를 안 주면 안 돈다** (2026-08-27 · D149) — 기능을 안 켠 것이지 고장이 아니다.
    **고정된 거치대는 여기 대상이 아니다.** 프로필 작업영역 상자에 로봇이 짚은 값으로 넣는다 —
    카메라 사슬(±수십 mm)보다 로봇(±0.02mm)이 정확하고, 태그가 가려도 안 흔들린다.
    여기가 맡는 것은 **자주 옮겨지는 받침**뿐이다 (D130 이 이 기능을 만든 이유 그대로).
    """
    if not cam_host or tag_id is None:
        # 주소나 id 를 안 준 것 = **기능을 안 켠 것**이다. 경고가 아니다
        _tracker["note"] = None
        return
    try:
        import cv2, numpy as np          # noqa: F401 — 없으면 아래 except 가 받는다
    except Exception as e:               # noqa: BLE001
        _tracker["note"] = f"받침 추적 꺼짐 — cv2 없음 ({str(e)[:40]})"
        return

    def loop():
        prev, streak = None, 0
        # 마지막 값을 이어받는다 — **못 보면 유지가 이 기능의 존재 이유**다
        try:
            with open(out_path, encoding="utf-8") as f:
                prev = json.load(f)
        except Exception:                # noqa: BLE001 — 없으면 없는 대로 시작한다
            prev = None
        while True:
            try:
                spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
                cal = json.loads(Path(calib_path).read_text(encoding="utf-8"))
                base = json.loads(Path(base_path).read_text(encoding="utf-8"))
                user = user_getter()
                if not user:
                    # user1 을 모르면 **프레임이 틀린 값을 낸다** — 안 쓴다 (제1원칙)
                    _tracker["note"] = "받침 추적 대기 — 로봇 미연결(user1 없음)"
                    time.sleep(period_s)
                    continue
                prev, streak = _tick(cam_host, out_path, spec, cal, base, user, prev, streak, tag_id)
            except Exception as e:       # noqa: BLE001 — **무슨 일이 있어도 브리지는 산다**
                _tracker["note"] = f"받침 추적 오류 — {str(e)[:60]}"
            time.sleep(period_s)

    t = threading.Thread(target=loop, name="fixture-tracker", daemon=True)
    t.start()
    _tracker["thread"] = t
    _tracker["note"] = None
