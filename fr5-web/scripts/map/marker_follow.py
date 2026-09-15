"""마커 추종 라이브러리 — 태그를 계속 풀어 **자리 파일로 내는 공용 뼈대** (D135 · 2026-08-19).

붙이는 쪽이 셋만 고른다:
  ① 어느 태그를 따라가나 — id 집합 (제원은 `tags.json` `fixtureTags` 의 `measuredMm`)
  ② 프레임을 어디서 받나 — `phone_frame`(폰 /shot.jpg) 또는 `latest_file_frame`(찍어 둔 사진)
  ③ 어디로 내나 — `write_anchors`(원자적 JSON) + 선택 `Mirror`(원격 사본 scp)

쓰는 곳 — `anchor-pose.py`(컨베이어 앵커 CLI · 상주는 `--watch`). 다음 후보 — 거치대
15·18·21 자리, 터틀봇 위치 보정(드리프트 실측 뒤 · D134). 화면 쪽 짝은
`Shared/view3d/anchor-overlay.js` 하나다 (그리기의 공용 뼈대 · 같은 날 같은 이유).

⛔ **안전 경로가 아니다.** 받침 게이트 추종의 정본은 `FR5/bridge/fixture.py` 다 (D130·D131 —
점프 가드·「못 보면 마지막 값으로 계속 막는다」·user1 프레임까지 안전 쪽 규칙이 따로 있다).
게이트가 읽을 값을 여기서 내지 마라 — 이 모듈은 **이야기 레이어**(가상 소품 자리)까지다.

⚠ **캘리브가 낡으면 여기 답도 낡는다** — 그리고 2026-08-19 부터 호스트 감시기가 `--auto` 로
**카메라 이동을 스스로 다시 푼다**(그날 16:33·16:48 실제로 걸렸다). 그래서 `Chain` 은
`conf_url` 을 주면 **호스트의 살아 있는 캘리브**를 읽고, 매 판 `refresh()` 로 기준샷(`shot`)이
바뀌었는지 봐서 사슬을 갈아탄다. 산출에는 `basis`(어느 기준샷으로 잰 값인가)가 실린다 —
없으면 「어느 정합으로 잰 앵커인가」를 나중에 못 가린다.
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "Shared/assets/tag/tags.json"
CONF = ROOT / "Shared/data/config/global-cam.json"

# 한 태그 4점 재투영이 이보다 나쁘면 그 태그는 안 쓴다. `check-calib.sh` 의 extrinsic
# 상한(0.6px · 4장 16점)보다 느슨한 이유 — 한 장짜리 IPPE 는 점이 4개뿐이라 더 튄다.
MAX_TAG_RMS = 2.0

# 못 찾은 태그를 다시 볼 때 쓰는 배율 — 아래 `Chain.solve` §못 찾은 것만 키워서.
# 2 로 잡히면 4 는 안 돈다(순서대로 시도하고 다 찾으면 멈춘다). 8 을 안 넣은 이유 —
# 실측에서 2·4 가 같은 답을 냈고, 더 키우면 검출 시간만 4배가 된다.
UPSCALES = (2, 4)


class Chain:
    """캘리브 사슬 + 태그 제원 + 검출기.

    `conf_url` 없음 → 이 레포의 `global-cam.json` 을 한 번 읽는다 (1회성 CLI 용).
    `conf_url` 있음 → 그 주소(보통 브리지 `/config/global-cam.json`)에서 읽고, `refresh()` 가
    기준샷이 바뀌면 사슬을 갈아탄다 — 호스트 자동 재정합(`watch-calib --auto`)을 따라간다.
    """

    def __init__(self, conf_url=None):
        spec = json.loads(SPEC.read_text(encoding="utf-8"))
        self.conf_url = conf_url
        self.size_of = {t["id"]: t.get("measuredMm") for t in spec.get("fixtureTags", [])}
        self.note_of = {t["id"]: t.get("note", "") for t in spec.get("fixtureTags", [])}
        dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
        params = cv2.aruco.DetectorParameters()
        # 멀고 흐린 태그에서 테두리를 갉아먹는 것을 막는다 (`extrinsics.py` 와 같은 이유)
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_APRILTAG
        self.det = cv2.aruco.ArucoDetector(dic, params)
        self.basis = None
        self._apply(self._read_conf())

    def _read_conf(self):
        if self.conf_url:
            with urllib.request.urlopen(self.conf_url, timeout=4) as r:
                return json.loads(r.read().decode("utf-8"))
        return json.loads(CONF.read_text(encoding="utf-8"))

    def _apply(self, conf):
        I = conf["intrinsics"]
        ext = conf.get("labToCam")
        if not ext:
            raise RuntimeError("global-cam.json 에 labToCam 이 없다 — extrinsics.py 부터")
        self.size_px = (I["widthPx"], I["heightPx"])
        self.K = np.array([[I["fx"], 0, I["cx"]], [0, I["fy"], I["cy"]], [0, 0, 1]])
        self.dist = np.array(I["dist"])
        self.R_lc, _ = cv2.Rodrigues(np.array(ext["rvec"]))
        self.t_lc = np.array(ext["tvecMm"]).reshape(3, 1)
        self.basis = ext.get("shot", "")

    def _detect(self, gray):
        """{id: 모서리 4x2} — 한 판 검출. 배율 재시도가 이걸 두 번 부른다."""
        corners, ids, _ = self.det.detectMarkers(gray)
        return {} if ids is None else {int(i): c[0] for c, i in zip(corners, ids.ravel())}

    def refresh(self, log=print):
        """기준샷이 바뀌었으면 사슬을 갈아탄다. 못 읽으면 **지금 사슬을 유지**한다 (한 번 못
        읽은 것과 캘리브가 죽은 것은 다르다). 바뀌었을 때만 True."""
        try:
            conf = self._read_conf()
        except Exception:
            return False
        shot = (conf.get("labToCam") or {}).get("shot", "")
        if shot and shot != self.basis:
            old = self.basis
            self._apply(conf)
            log(f"  {time.strftime('%H:%M:%S')} 캘리브 갈아탐 — {old} → {self.basis}")
            return True
        return False

    def solve(self, gray, want, log=print):
        """{id: {labMm·yawDeg·errPx}} — 안 보이거나 RMS 초과인 태그는 **빠진다** (지우는 쪽 판단은
        싱크 몫이다 — `write_anchors` 는 안 보인 id 의 옛 값을 남긴다)."""
        if gray is None:
            raise ValueError("사진이 없다")
        w, h = gray.shape[1], gray.shape[0]
        K = self.K
        if (w, h) != self.size_px:
            # 폰 앱이 재시작하면 해상도가 조용히 되돌아간다 (1440p→1080p · 워처가 47분 침묵한
            # 실사고 08-19). 폰은 자르지 않고 **줄이기만 하므로** 내부 파라미터를 비례로 받는다 —
            # 동료 세션 실측: 2560/1920/1280 에서 카메라 위치 차 2.7·0.5mm. 왜곡 계수는 정규화
            # 좌표라 해상도 무관. **가로세로비가 다르면 그건 다른 카메라다** — 거부.
            if abs(w / h - self.size_px[0] / self.size_px[1]) > 0.005:
                raise ValueError(f"사진 {w}x{h} 가로세로비 ≠ 캘리브 {self.size_px[0]}x{self.size_px[1]}")
            s = w / self.size_px[0]
            K = self.K.copy()
            K[0, 0] *= s; K[1, 1] *= s; K[0, 2] *= s; K[1, 2] *= s
        found = self._detect(gray)
        # **못 찾은 것만 키워서 한 번 더 본다** (2026-08-28 · 터틀봇 id18).
        # 라이다 위 84mm 태그가 원본 1920x1080 에서 **0개**, 2배에서 잡혔다 — 휘어서가 아니라
        # 화소가 문턱에 못 미쳐서다. 확대는 정보를 안 만들지만 검출기의 사각형 후보 문턱은
        # 넘겨 준다. **모서리를 배율로 나눠 원본 화소로 되돌리므로 PnP 는 그대로다** —
        # 새 좌표계도, 새 보정도 없다. 재투영 RMS 검사가 그 뒤에 그대로 걸린다.
        # 비용이 있으니(1920→3840 검출 ~0.4s) **빠진 게 있을 때만** 돈다.
        if any(t not in found for t in want):
            for up in UPSCALES:
                big = cv2.resize(gray, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
                for tid, c in self._detect(big).items():
                    if tid not in found:
                        found[tid] = c / up
                if all(t in found for t in want):
                    break
        out = {}
        for tid in sorted(want):
            if tid not in found:
                continue
            s = self.size_of.get(tid)
            if not s:
                log(f"  id{tid}: tags.json 에 measuredMm 가 없다 — 자로 재서 적고 다시")
                continue
            h = s / 2.0
            # detectMarkers 모서리 순서(TL·TR·BR·BL)와 짝 — IPPE_SQUARE 가 이 순서를 요구한다.
            # ⛔ 크기는 선언이 아니라 **실측** — 선언으로 풀면 크기 오류가 깊이 오류로 나온다 (id6 215.8mm)
            op = np.array([[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]], np.float64)
            ip = np.array(found[tid], np.float64)
            ok, rvec, tvec = cv2.solvePnP(op, ip, K, self.dist, flags=cv2.SOLVEPNP_IPPE_SQUARE)
            if not ok:
                continue
            proj, _ = cv2.projectPoints(op, rvec, tvec, K, self.dist)
            rms = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - ip) ** 2, axis=1))))
            if rms > MAX_TAG_RMS:
                log(f"  id{tid}: 재투영 {rms:.2f}px > {MAX_TAG_RMS} — 버린다 (기울었거나 안 평평하다)")
                continue
            lab = (self.R_lc.T @ (tvec - self.t_lc)).ravel()
            # 눕힌 태그의 평면 방위 — 종이를 돌리면 이 값이 돈다. 세운 태그에선 뜻이 없다
            R_tag, _ = cv2.Rodrigues(rvec)
            vx = (self.R_lc.T @ R_tag @ np.array([1.0, 0, 0])).ravel()
            yaw = float(np.degrees(np.arctan2(vx[1], vx[0])))
            out[tid] = {"labMm": [round(float(v), 1) for v in lab],
                        "yawDeg": round(yaw, 1), "errPx": round(rms, 2)}
        return out


def phone_frame(host):
    """폰 정지샷 한 장. MJPEG 스트림을 물지 않는다 — 한 프레임이면 충분하고 연결도 안 쌓인다."""
    r = urllib.request.urlopen(f"http://{host}/shot.jpg", timeout=4)
    return cv2.imdecode(np.frombuffer(r.read(), np.uint8), cv2.IMREAD_GRAYSCALE), f"{host}/shot.jpg"


def latest_file_frame(path=None):
    """찍어 둔 사진 — `path` 없으면 `calib-shots/tags` 의 최신. (사진, 이름, 나이분)."""
    shots_dir = ROOT / "calib-shots/tags"
    shots = sorted(shots_dir.glob("*.png")) + sorted(shots_dir.glob("*.jpg"))
    shot = Path(path) if path else max(shots, key=lambda p: p.stat().st_mtime, default=None)
    if shot is None or not shot.exists():
        raise FileNotFoundError("사진이 없다 — scripts/map/capture.py tags --shots 1")
    age_min = (time.time() - shot.stat().st_mtime) / 60
    return cv2.imread(str(shot), cv2.IMREAD_GRAYSCALE), shot.name, age_min


def write_anchors(out_path, solved, chain, shot_name, header_extra=None):
    """병합 + **원자적** 쓰기. 이 파일은 화면(3초 폴링)·scp 가 아무 때나 읽는다 — write_text 로
    바로 덮으면 읽는 쪽이 반쯤 쓰인 판을 집을 수 있다. 안 보인 id 의 옛 값은 **남긴다**."""
    doc = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {
        "_생성됨": "scripts/map/marker_follow.py 를 통해 — 직접 고치지 마라",
        "_단위": "밀리미터 · lab(태그0 카트 덱 평면) 좌표 · z 는 덱 위가 +",
        **(header_extra or {}),
        "anchors": {},
    }
    for tid, v in solved.items():
        doc["anchors"][str(tid)] = {
            **v, "note": chain.note_of.get(tid, ""), "shot": shot_name,
            # 어느 기준샷(캘리브)으로 잰 값인가 — 호스트가 스스로 재정합하는 판이라 이게 없으면
            # 「어느 정합으로 잰 앵커인가」를 나중에 못 가린다 (동료 세션 지적 · 08-19)
            "basis": chain.basis,
            "solvedAt": time.strftime("%Y-%m-%d %H:%M"),
            # 나이 판정용 — 감시가 죽으면 이 값이 얼어붙고, 읽는 쪽이 늙음을 본다
            "t": round(time.time(), 1),
        }
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(out_path)
    return doc


class Mirror:
    """원격 사본 — **자리가 바뀔 때 + 심장박동(60초)** 만 민다. 매 판 밀면 sshd 가 얻어맞는다
    (소스 페널티 실측 2026-08-18). 값은 장면 사실이라 기계별 산출물이 아니다 — 밀어도 된다
    (D129 의 drift 금지와 다른 종류)."""

    HEARTBEAT_S = 60

    def __init__(self, target):
        self.target = target          # 예: "user@host:FR5Web/Shared/data/config/scene-anchors.json"
        self._key = None
        self._at = 0.0

    def push(self, out_path, doc, log=print):
        key = json.dumps([(k, v["labMm"], v["yawDeg"]) for k, v in sorted(doc["anchors"].items())])
        if key == self._key and time.time() - self._at < self.HEARTBEAT_S:
            return False
        r = subprocess.run(["scp", "-q", "-o", "ConnectTimeout=10", str(out_path), self.target],
                           capture_output=True, text=True)
        if r.returncode != 0:
            log(f"  미러 실패 — {r.stderr.strip() or r.returncode} (다음 판에 다시)")
            return False
        if key != self._key:
            log(f"  {time.strftime('%H:%M:%S')} 미러 — 자리가 바뀌어 밀었다")
        self._key, self._at = key, time.time()
        return True


def follow(chain, want, out_path, host, period=2.0, mirror=None, log=print):
    """상주 루프. 실패해도 죽지 않는다 — 한 프레임 못 받은 것과 감시가 죽은 것은 다르다."""
    log(f"감시 시작 — {host} · {period}초 주기 · 대상 {sorted(want)} (Ctrl-C 로 끝낸다)")
    last = -1
    while True:
        try:
            chain.refresh(log=log)          # 호스트 자동 재정합을 따라간다 (기준샷 대조 · 싸다)
            gray, name = phone_frame(host)
            solved = chain.solve(gray, want, log=log)
            if solved:
                doc = write_anchors(out_path, solved, chain, name)
                if mirror:
                    mirror.push(out_path, doc, log=log)
            if len(solved) != last:
                log(f"  {time.strftime('%H:%M:%S')} 앵커 {len(solved)}개")
                last = len(solved)
        except KeyboardInterrupt:
            return 0
        except Exception as e:                     # 폰 무응답·프레임 깨짐 — 다음 판에 다시
            log(f"  {time.strftime('%H:%M:%S')} 건너뜀 — {e}")
        time.sleep(period)
