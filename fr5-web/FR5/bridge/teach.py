# Teach 도메인 — 지점(점)과 궤적(선) (API-CONTRACT §이동 지점 · §궤적 녹화 · D74).
#
# **지점은 점이고 궤적은 선이다.** 둘 다 "일어난 일을 적는 것" 이라 같은 모듈에 산다.
# 값의 정본은 **서버가 읽은 상태**다 — 화면이 보낸 좌표를 저장하지 않는다 (계약 §이동 지점).
#
# tb-bridge 의 RunStore·MapStore 와 같은 모양 — 도메인은 클래스, 라우트는 얇게 (D54).
# 이 모듈은 main 을 모른다 (순환 import 금지).
import asyncio
import json
import math
import re
import time
from pathlib import Path

# 녹화 상한 — 무한 기록은 디스크와 메모리 둘 다 먹는다 (계약 §궤적 녹화)
MAX_DURATION_S = 120.0
MAX_FRAMES = 6000
# 이 안이면 "같은 자세" 로 본다. 지점 이름을 궤적의 startPose 에 붙일 때만 쓴다
SAME_POSE_DEG = 0.5

# 궤적 이름은 **파일 이름이 된다.** 그래서 이름 자체를 좁힌다 (감사 2026-08-05 P0-2).
# `pathlib` 은 오른쪽이 절대경로면 왼쪽을 버린다 — `Path("~/fr5-data") / "/etc/cron.d/x"`
# 가 `/etc/cron.d/x` 다. 조종권만 있으면 ARM 없이 브리지 계정의 아무 파일이나 덮어썼다.
# **거르지 않고 자르지 않는다** — 잘라 주면 두 이름이 한 파일이 되어 조용히 덮어쓴다.
SAFE_NAME = re.compile(r"^[A-Za-z0-9가-힣_-]{1,64}$")


def safe_name(name):
    """파일 이름이 될 수 있는 이름만 통과. 반환: (이름, 사유목록)."""
    name = str(name or "").strip()
    if not name:
        return None, ["이름이 비어 있다"]
    if not SAFE_NAME.match(name):
        return None, ["이름은 한글·영문·숫자·`_`·`-` 만 쓰고 64자를 넘지 않는다 "
                      f"(받은 것: {name[:80]!r})"]
    return name, []


def _finite_list(v, n):
    return (isinstance(v, (list, tuple)) and len(v) >= n
            and all(isinstance(x, (int, float)) and not isinstance(x, bool)
                    and math.isfinite(x) for x in v[:n]))


class PointStore:
    """지점 전부를 파일 하나에 담는다.

    ponytail: 파일 하나 · 전체 rewrite. 조종권 1명 규칙이 동시 쓰기를 사실상 막는다.
    천장 — 여러 로봇·수백 지점으로 커지면 로봇별로 갈라야 한다 (GOAL-teach-points §5).
    """

    def __init__(self, data_dir):
        self._path = Path(data_dir) / "points.json"

    def _load(self):
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []
        return data if isinstance(data, list) else []

    def _save(self, items):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # 임시 파일에 쓰고 바꿔치기 — 쓰다 죽어도 옛 목록이 남는다 (반쪽 JSON 이 안 남는다)
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self._path)

    def list(self):
        return self._load()

    def get(self, name):
        return next((p for p in self._load() if p.get("name") == name), None)

    def capture(self, name, state, robot_id):
        """**서버가 읽은 상태**를 굳힌다. 같은 이름이면 덮어쓴다 (다시 가르치는 것이 정상이다)."""
        if not isinstance(name, str) or not name.strip():
            return None, ["이름이 비어 있다"]
        coord = state.get("coord") or {}
        grip = state.get("gripper") or {}
        pct = grip.get("pct")
        point = {
            "name": name.strip(),
            "jointsDeg": list(state.get("jointsDeg") or []),
            "tcpMmDeg": list(state.get("tcpMmDeg") or []),
            # 못 읽었으면 **null** 이다 — 0 으로 채우면 "완전히 닫힘" 과 구분이 안 된다
            "gripperPct": pct if isinstance(pct, (int, float)) else None,
            "toolId": coord.get("toolId", 0),
            "userId": coord.get("userId", 0),
            "capturedRobotId": robot_id,
            "capturedAt": time.time(),
        }
        if not _finite_list(point["jointsDeg"], 6):
            return None, ["관절값을 못 읽었다 — 캡처하지 않는다 (제1원칙: 결측=차단)"]
        items = [p for p in self._load() if p.get("name") != point["name"]]
        items.append(point)
        self._save(items)
        return point, []

    def delete(self, name, refs=()):
        """참조하는 슬롯이 있으면 **지우지 않는다** — 승인된 리비전이 깨진 참조를 가리키면
        실행 시점에야 드러난다 (계약 §이동 지점 · 감사 P1)."""
        if refs:
            return False, list(refs)
        items = self._load()
        left = [p for p in items if p.get("name") != name]
        if len(left) == len(items):
            return False, []
        self._save(left)
        return True, []

    def name_of_pose(self, joints_deg):
        """이 자세에 이름이 붙어 있나. 없으면 None."""
        if not _finite_list(joints_deg, 6):
            return None
        for p in self._load():
            j = p.get("jointsDeg") or []
            if _finite_list(j, 6) and all(
                    abs(a - b) <= SAME_POSE_DEG for a, b in zip(j[:6], joints_deg[:6])):
                return p.get("name")
        return None


def frame_mismatch(point, coord):
    """지점의 좌표계가 지금과 다른가. 다르면 **이동 전에** 막는다 —
    그리퍼 장착 전(tool0) 지점을 장착 후에 재생하면 파지 실패가 아니라 충돌이 된다 (감사 P0)."""
    coord = coord or {}
    now_t, now_u = coord.get("toolId", 0), coord.get("userId", 0)
    was_t, was_u = point.get("toolId", 0), point.get("userId", 0)
    if (now_t, now_u) != (was_t, was_u):
        return [f"좌표계가 잴 때와 다르다 — 지점 tool{was_t}/user{was_u} · "
                f"지금 tool{now_t}/user{now_u} (계약 §이동 지점)"]
    return []


class TrajectoryStore:
    """궤적 하나가 파일 하나. **읽기만 하는 기록**이라 로봇 명령 허용목록과 무관하다."""

    def __init__(self, data_dir):
        self._dir = Path(data_dir) / "trajectories"

    def list(self):
        """프레임은 빼고 요약만 — 목록 하나에 수천 프레임을 실어 보내지 않는다."""
        out = []
        for f in sorted(self._dir.glob("*.json")) if self._dir.exists() else []:
            try:
                t = json.loads(f.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            out.append({k: v for k, v in t.items() if k != "frames"}
                       | {"frameCount": len(t.get("frames") or [])})
        return out

    def _path(self, name):
        """이름 → 파일 경로. **폴더 밖으로 나가면 None 이다** (감사 P0-2).

        이름 검사(`safe_name`)만으로 이미 막히지만, 여기서 `resolve()` 로 한 번 더 본다 —
        이 두 줄이 마지막 방어선이라 호출처가 검사를 빠뜨려도 파일이 안 새어 나간다."""
        ok, _ = safe_name(name)
        if not ok:
            return None
        path = (self._dir / f"{ok}.json").resolve()
        return path if path.parent == self._dir.resolve() else None

    def get(self, name):
        path = self._path(name)
        if path is None:
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

    def save(self, traj):
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._path(traj.get("name"))
        if path is None:            # 여기까지 왔으면 호출처가 검사를 빠뜨린 것이다
            raise ValueError(f"궤적 이름을 파일로 쓸 수 없다 — {traj.get('name')!r}")
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(traj, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        return traj


class Recorder:
    """녹화 중인 궤적 하나. **로봇을 움직이지 않는다** — 상태 스트림을 시간축으로 적을 뿐이다.

    표본 간격은 흔들린다(파이썬·WS·xmlrpc). 그래서 **원본 시각을 그대로 담아 두고
    끝낼 때 고정 주기 격자로 재표본**한다 — `fps` 가 거짓말이 되지 않게 (D74).
    """

    def __init__(self, name, purpose, source, fps, stamp, start_pose_name=None):
        self.name = name
        self.purpose = purpose if purpose in ("measure", "collect") else "measure"
        self.source = source if source in ("demo", "postproc", "policy") else "demo"
        self.fps = fps
        self.stamp = stamp
        self.startPoseName = start_pose_name
        self.t0 = time.time()
        self.raw = []               # [(tSec, jointsDeg, tcpMmDeg, gripperPct)]
        self.endReason = None

    def push(self, state):
        """상태 한 장. 상한에 닿으면 `timeout` 으로 스스로 닫는다."""
        t = time.time() - self.t0
        if t > MAX_DURATION_S or len(self.raw) >= MAX_FRAMES:
            self.endReason = "timeout"
            return False
        joints = list(state.get("jointsDeg") or [])
        if not _finite_list(joints, 6):
            return True                     # 불량 표본은 버린다 — 격자에서 dropped 로 잡힌다
        grip = state.get("gripper") or {}
        pct = grip.get("pct")
        self.raw.append((t, joints[:6], list(state.get("tcpMmDeg") or [])[:6],
                         pct if isinstance(pct, (int, float)) else None))
        # 안전 사건은 **그 자리에서 이유가 된다** — 나중에 상태로 되짚으면 순서를 못 가른다
        sf = state.get("safety") or {}
        if sf.get("emergencyStop"):
            self.endReason = "estop"
            return False
        if sf.get("collisionDetected"):
            self.endReason = "collision"
            return False
        return True

    def finish(self, reason=None):
        """고정 주기 격자로 재표본하고 `dropped` 를 센다."""
        self.endReason = self.endReason or reason or "done"
        period = 1.0 / self.fps
        duration = self.raw[-1][0] if self.raw else 0.0
        frames, dropped = [], 0
        n = int(duration / period) + 1 if self.raw else 0
        for i in range(n):
            t = i * period
            near = self._at(t)
            if near is None:
                dropped += 1
                continue
            frames.append({"tSec": round(t, 4),
                           "jointsDeg": [round(v, 4) for v in near[0]],
                           "tcpMmDeg": [round(v, 3) for v in near[1]],
                           "gripperPct": near[2]})
        return {
            "name": self.name, "source": self.source, "purpose": self.purpose,
            "fps": self.fps, "durationSec": round(duration, 3),
            "startPose": ({"jointsDeg": frames[0]["jointsDeg"], "name": self.startPoseName}
                          if frames else None),
            "endReason": self.endReason,
            "dropped": dropped,
            "stamp": self.stamp,
            "recordedAt": self.t0,
            "frames": frames,
        }

    def _at(self, t):
        """격자 시각 `t` 의 값. 앞뒤 표본을 선형 보간하되, **한 주기 안에 표본이 하나도
        없으면 지어내지 않고 결손으로 센다** — 없는 구간을 이어 붙이면 재생이 튄다."""
        period = 1.0 / self.fps
        prev = nxt = None
        for s in self.raw:
            if s[0] <= t:
                prev = s
            else:
                nxt = s
                break
        if prev is None and nxt is None:
            return None
        # 격자점에 **진짜 표본이 붙어 있으면** 그걸 쓴다. 건너편이 아무리 멀어도 이 칸은
        # 결손이 아니다 — 이걸 안 보면 녹화의 첫 칸이 뒤가 비었다는 이유로 버려진다
        for s in (prev, nxt):
            if s is not None and abs(s[0] - t) <= period / 2:
                return (s[1], s[2], s[3])
        if prev is None:
            return (nxt[1], nxt[2], nxt[3]) if nxt[0] - t <= period else None
        if nxt is None:
            return (prev[1], prev[2], prev[3]) if t - prev[0] <= period else None
        if nxt[0] - prev[0] > period * 2:      # 사이가 두 주기보다 벌어졌다 = 결손
            return None
        k = (t - prev[0]) / (nxt[0] - prev[0]) if nxt[0] > prev[0] else 0.0
        lerp = lambda a, b: [x + (y - x) * k for x, y in zip(a, b)]
        pct = prev[3] if prev[3] is not None else nxt[3]
        return (lerp(prev[1], nxt[1]),
                lerp(prev[2], nxt[2]) if len(prev[2]) == len(nxt[2]) else prev[2],
                pct)


class TeachService:
    """지점·궤적·녹화를 한 손에 쥔다. **라우트는 이걸 부르기만 한다** (D54 · tb-bridge 모양).

    로봇을 모른다 — 상태를 읽는 함수를 받아서 쓴다. 그래서 session 을 import 하지 않고
    순환도 없다. 녹화는 **읽기 전용**이라 명령 허용목록과 무관하다.
    """

    def __init__(self, data_dir, fps, on_log):
        self.points = PointStore(data_dir)
        self.trajectories = TrajectoryStore(data_dir)
        self.fps = max(1, int(fps))
        self._log = on_log
        self._rec = None

    @property
    def recording(self):
        """녹화 중이면 이름, 아니면 None. 조종권이 한 명이라 동시 녹화도 하나다."""
        return self._rec.name if self._rec else None

    def start(self, name, purpose, source, stamp, state):
        if self._rec is not None:
            return None, [f"이미 녹화 중 — {self._rec.name}. 먼저 stop"]
        # 이름이 파일 이름이 된다 — 녹화를 **시작하기 전에** 거른다. 끝날 때 거르면
        # 120초를 녹화하고 저장에서 버리게 된다 (감사 P0-2)
        name, reasons = safe_name(name)
        if reasons:
            return None, reasons
        start_name = self.points.name_of_pose(state.get("jointsDeg"))
        self._rec = Recorder(name, purpose, source, self.fps, stamp, start_name)
        self._rec.push(state)
        self._log("traj-start", f"{name} purpose={self._rec.purpose} fps={self.fps} "
                                f"출발={start_name or '이름 없는 자세'}")
        return {"name": name, "fps": self.fps, "purpose": self._rec.purpose,
                "startPoseName": start_name}, []

    def push(self, state):
        """상태 한 장. 더 받을 수 없으면 False (상한·비상정지·충돌)."""
        return self._rec.push(state) if self._rec else False

    def finish(self, reason=None):
        """녹화를 닫고 저장한다. 녹화 중이 아니면 None — 두 번 불려도 안전하다."""
        rec, self._rec = self._rec, None
        if rec is None:
            return None
        traj = self.trajectories.save(rec.finish(reason))
        self._log("traj-stop", f"{traj['name']} {traj['durationSec']}s "
                               f"프레임 {len(traj['frames'])} 결손 {traj['dropped']} "
                               f"끝={traj['endReason']}")
        return traj

    def fail(self, reason):
        """연결이 끊겼다 — 적은 데까지는 남긴다. 안 닫으면 프레임을 다 적고도 파일이 안 남는다."""
        if self._rec is not None:
            self._rec.endReason = reason
            return self.finish()
        return None

    @staticmethod
    def summary(traj):
        """목록·응답용 — 프레임 수천 개를 실어 보내지 않는다."""
        return {k: v for k, v in traj.items() if k != "frames"} | {
            "frameCount": len(traj.get("frames") or [])}


async def run_recording(svc, read_state, period):
    """녹화 루프 — **로봇에 아무것도 보내지 않는다.** 상태를 읽는 함수를 받아 쓰므로
    이 모듈은 여전히 session 을 모른다 (순환 import 금지).

    끊기면 적은 데까지 남긴다 — 안 닫으면 프레임을 다 적고도 파일이 안 남는다.
    """
    while svc.recording:
        try:
            state = await asyncio.to_thread(read_state)
        except Exception:
            await asyncio.to_thread(svc.fail, "disconnect")
            return
        if state is None:
            await asyncio.to_thread(svc.fail, "disconnect")
            return
        if not svc.push(state):        # 상한·비상정지·충돌 — 사유는 Recorder 가 들고 있다
            await asyncio.to_thread(svc.finish)
            return
        await asyncio.sleep(period)
