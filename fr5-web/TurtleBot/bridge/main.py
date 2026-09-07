# tb-bridge — 터틀봇의 유일한 관문 (TB-CONTRACT.md 가 정본이다. 어긋나면 문서부터 고친다).
# 실행: uv run --with fastapi --with uvicorn --with pyyaml uvicorn main:app --host 0.0.0.0 --port 5055
import asyncio
import json
import os
import re
import shutil
import time
from pathlib import Path

import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import map_image

import geofence
import paths as path_mod
import safety
import slots as slot_scan
from log_stream import LogStream
from maps import MapStore
from owner import OwnerRegistry
from process_runner import ProcessRunner
from ros_adapter import make_adapter
from runs import RunStore

HERE = Path(__file__).parent
CONFIG = yaml.safe_load((HERE / "config.yaml").read_text())
ROBOT_IDS = [r["id"] for r in CONFIG["robots"]]

logs = LogStream()
adapter, ADAPTER_KIND = make_adapter(ROBOT_IDS, logs.emit)
runs = RunStore(logs.emit)
maps = MapStore()
paths = path_mod.PathStore()
owners = OwnerRegistry(ROBOT_IDS, lambda robot, who: adapter.patch(robot, owner=who), logs.emit)


def _slot_exited(robot, run_id, result):
    # 어떤 이유로든 프로세스가 죽으면 — 브리지가 정지를 보장한다 (감사 R1)
    adapter.stop(robot)
    adapter.patch(robot, activeSlot=None, activeRunId=None)
    runs.end(run_id, result)


procs = ProcessRunner(logs.emit, _slot_exited)

# 기동 한 줄을 버퍼에 남긴다. 없으면 갓 뜬 브리지의 로그 패널이 **빈 채로 열려**, 보는 사람이
# "로그가 안 오나" 와 "아직 아무 일도 없었나" 를 못 가른다 (2026-08-06). 계약 §로그의
# "새 접속에 백로그 먼저" 도 버퍼가 비면 줄 게 없다. adapter 종류를 여기 남기면 나중에
# 기록을 되짚을 때 **그 세션이 mock 이었는지 실기였는지**가 로그만으로 판별된다 (SR_24).
logs.emit("—", "bridge", "info",
          f"tb-bridge 기동 · adapter={ADAPTER_KIND} · 로봇 {', '.join(ROBOT_IDS)}")

app = FastAPI(title="tb-bridge")

# ── CORS — 읽기는 어디서든, 쓰기는 FR5 조작 화면의 출처에서만 (계약 §미래 접점 ④ · D182)
#
# 소비자(FR5 웹 `:5055`·AR·Dashboard)는 **다른 주소에서 서빙되는 화면**이라 브라우저가
# 「다른 출처」로 보고 막는다. `/ws/state`(웹소켓은 이 규칙을 안 탄다)는 되는데 `GET /api/runs`
# 는 안 됐다 — 계약이 열어 둔 문이 구현에서 닫혀 있었다 (2026-08-28).
#
# 2026-09-05 (D182): 터틀봇 웹앱이 퇴역하고 **FR5 조작 화면의 「터틀봇」 탭이 유일한 조작 화면**
# 이 됐다. 그 화면은 FR5 브리지(`:5055`)가 서빙하므로 **그 출처에만** `POST`·`PUT`·`PATCH`·
# `DELETE` 를 연다(dev·게이트는 vite `:5176`). 다른 출처의 쓰기는 403 이다.
# 하드룰 4(명령 주인은 한 명)를 지키는 것은 출처가 아니라 §조종권(hello 세션 바인딩·owner)이다 —
# 출처 제한은 「아무 페이지나 몰 수 있다」를 막는 두 번째 울타리다. `allow_credentials` 는 안 켠다.
# ⛔ 호스트도 본다 (감사 2026-09-05 P0). 처음엔 `[^/]+` 라 **어느 호스트든 :5055 면 통과**했다 — 바깥 사이트가
# 자기 서버를 5055 로 띄우면 울타리가 없는 셈이었다. 지금은 사설망(192.168/10/172.16~31)·localhost·`.local` 이름만.
# 공인 주소로 서빙하게 되면 `TB_WRITE_ORIGIN_RE` 로 그 호스트 하나를 박는다 — 넓히지 말고 좁힌다.
WRITE_ORIGIN_RE = os.environ.get(
    "TB_WRITE_ORIGIN_RE",
    r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.local):(5055|5176)$")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
)


@app.middleware("http")
async def _write_origin_gate(request, call_next):
    """쓰기 메서드는 FR5 조작 화면의 출처에서만 받는다 (계약 ④). Origin 이 없는 요청(curl·
    슬롯 스크립트·같은 기계)은 브라우저가 아니라 CORS 대상이 아니다 — 그대로 통과한다."""
    origin = request.headers.get("origin")
    if origin and request.method in ("POST", "PUT", "PATCH", "DELETE") \
            and not re.match(WRITE_ORIGIN_RE, origin):
        return JSONResponse({"ok": False, "reason": f"쓰기는 FR5 조작 화면에서만 — 출처 {origin} 거부 (계약 §미래 접점 ④)"},
                            status_code=403)
    return await call_next(request)


def ok(**extra):
    return {"ok": True, **extra}


def refuse(reason, status=400):
    return JSONResponse({"ok": False, "reason": reason}, status_code=status)


# ── 지오펜스 — 상판 낙하 방지 경계 (계약 §지오펜스 · D134) ──────────────────
# 로봇이 못 보는 것(모서리)을 브리지가 대신 본다. 값은 config.yaml 에 살고 코드엔 좌표가 없다.
FENCES = {r["id"]: geofence.parse(r.get("geofence")) for r in CONFIG["robots"]}
for _rid, _f in FENCES.items():
    if _f is None:
        logs.emit(_rid, "bridge", "info",
                  "지오펜스 없음 — 경계 판정을 하지 않아요. 상판 위 주행 금지 (계약 §지오펜스)")
    elif _f.error:
        # 깨져도 브리지는 뜬다 — 안 뜨면 estop 도 못 보낸다. 대신 그 로봇은 영구 거부다
        logs.emit(_rid, "bridge", "error",
                  f"지오펜스 설정이 깨졌어요 — {_f.error} · 이 로봇의 이동은 전부 거부돼요")
    else:
        logs.emit(_rid, "bridge", "info",
                  f"지오펜스 켬 — 점 {len(_f.polygon)}개 · 여유선 {_f.inset_mm:.0f}mm · frame={_f.frame}")


def fence_state(robot, r):
    f = FENCES.get(robot)
    return f.evaluate(r["pose"], r["poseAgeSec"]) if f else None


def fence_block(robot, r, linear=1, angular=0):
    """이동을 막을 사유 (통과면 None). 정지 명령은 지오펜스가 막지 않는다."""
    return geofence.blocks_motion(FENCES.get(robot), fence_state(robot, r), linear, angular)


# 흉내만 내는 하위기능 — 브리지가 자기 입으로 말한다 (계약 §목업 목록 · 전수조사 2026-08-19).
# `adapter:real` 은 어댑터 하나만 가리킨다 — 여기 있는 것은 어댑터와 무관하게 가짜다.
# **구현하면 이 목록에서 지운다.** 지우는 것이 곧 완료 신호다.
MOCKED = [
    "mapping",    # SLAM 을 안 띄운다 — nav 만 starting→running
    "maps",       # 저장이 `# mock map — 이름` 한 줄 (pgm 없음)
    "liveMap",    # live.png 는 궤적 주변을 밝힌 그림 (map_image.py)
    "rosbag",     # 경로 문자열만 run 에 넣는다
]


def snapshot():
    robots = adapter.robots()
    for rid, r in robots.items():
        r["geofence"] = fence_state(rid, r)
    return {"t": time.time(), "adapter": ADAPTER_KIND, "mocked": MOCKED, "robots": robots}


# ── WebSocket /ws/state — 상태 브로드캐스트 + hello·teleop·estop ────────────
@app.websocket("/ws/state")
async def ws_state(ws: WebSocket):
    await ws.accept()
    who = None

    async def sender():
        while True:
            await ws.send_text(json.dumps(snapshot()))
            await asyncio.sleep(0.1)                      # 100ms 목표 (계약)

    send_task = asyncio.create_task(sender())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            cmd = msg.get("cmd")
            if cmd == "estop":                            # 신원·조종권 무관 항상 통과
                do_estop(msg.get("robot"))
                continue
            if cmd == "hello":
                if who:
                    owners.session_close(who)
                who = str(msg.get("who") or "")
                owners.session_open(who)
                continue
            if not who:                                   # hello 없는 세션 — estop 빼고 거부
                await ws.send_text(json.dumps({"ok": False, "reason": "hello 로 신원을 먼저 묶어요"}))
                continue
            if cmd == "teleop":
                robot = msg.get("robot")
                if robot not in ROBOT_IDS:
                    continue
                res = do_teleop(robot, msg.get("linearMmS"), msg.get("angularDegS"), who)
                if not res["ok"]:
                    await ws.send_text(json.dumps(res))
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        if who:
            owners.session_close(who)


def do_teleop(robot, linear, angular, who):
    if not owners.is_owner(robot, who):
        return {"ok": False, "reason": "조종권이 없어요"}
    r = adapter.robots()[robot]
    mode = r["mode"]
    if mode not in ("idle", "teleop", "mapping"):         # 전이 규칙 — mapping 은 예외 수락
        return {"ok": False, "reason": f"mode={mode} — teleop 거부"}
    reason = safety.check_teleop(linear, angular)
    if reason:
        return {"ok": False, "reason": reason}
    blocked = fence_block(robot, r, linear, angular)      # 정지(0,0)는 여기서 안 막힌다
    if blocked:
        return {"ok": False, "reason": f"지오펜스 — {blocked}"}
    adapter.set_velocity(robot, linear, angular)
    return {"ok": True}


def do_estop(robot=None):
    targets = [robot] if robot in ROBOT_IDS else ROBOT_IDS
    for rid in targets:
        logs.emit(rid, "bridge", "warn", "E-STOP — 즉시 정지 + 슬롯 종료 (owner 유지)")
        if not procs.stop(rid, reason="estop"):
            adapter.stop(rid)                             # 슬롯 없으면 즉시. 있으면 exit 콜백이 정지


@app.websocket("/ws/logs")
async def ws_logs(ws: WebSocket):
    await ws.accept()
    queue = asyncio.Queue()
    logs.subscribe(queue)
    try:
        while True:
            await ws.send_text(json.dumps(await queue.get()))
    except WebSocketDisconnect:
        pass
    finally:
        logs.unsubscribe(queue)


# ── 조종권 ──────────────────────────────────────────────────────────────────
@app.post("/api/owner/claim")
async def owner_claim(body: dict):
    okey, reason = owners.claim(body.get("robot"), body.get("who"))
    return ok() if okey else refuse(reason, 409)


@app.post("/api/owner/release")
async def owner_release(body: dict):
    okey, reason = owners.release(body.get("robot"), body.get("who"))
    return ok() if okey else refuse(reason, 409)


# ── 슬롯 ────────────────────────────────────────────────────────────────────
@app.get("/api/slots")
async def get_slots():
    return slot_scan.list_slots()


@app.post("/api/slots/{name}/start")
async def start_slot(name: str, body: dict):
    robot, who = body.get("robot"), body.get("who")
    if safety.check_name(name):
        return refuse(safety.check_name(name))
    if robot not in ROBOT_IDS:
        return refuse("없는 로봇")
    if not owners.is_owner(robot, who):
        return refuse("조종권이 없어요", 403)
    if adapter.robots()[robot]["mode"] != "idle":
        return refuse(f"mode={adapter.robots()[robot]['mode']} — 시작은 idle 에서만 (TB-CONTRACT §모드 전이)")
    blocked = fence_block(robot, adapter.robots()[robot])  # 슬롯은 움직이는 것이 일이다 — 밖이면 시작부터 거부
    if blocked:
        return refuse(f"지오펜스 — {blocked}")
    f = slot_scan.slot_file(name)
    if not f:
        return refuse("없는 슬롯", 404)
    params = body.get("params") or {}
    if len(json.dumps(params)) > safety.PARAMS_MAX:
        return refuse("params 4KB 상한 초과")
    active_map = adapter.robots()[robot]["activeMap"]
    run = runs.create(robot, active_map, name, params)
    adapter.patch(robot, mode="slot", activeSlot=name, activeRunId=run["id"])
    procs.start(robot, name, f, run["id"], maps.yaml_path(active_map) if active_map else "", params)
    return JSONResponse(ok(runId=run["id"]), status_code=202)   # spawn 성공만 뜻한다 (계약)


@app.post("/api/robots/{robot}/reset-odom")
async def reset_odom(robot: str, body: dict):
    """지금 자세를 (0,0,0) 으로 (계약 §원점 재설정). 저장된 경로는 그대로 두고 기준만 바뀐다."""
    if robot not in ROBOT_IDS:
        return refuse("없는 로봇")
    if not owners.is_owner(robot, body.get("who")):
        return refuse("조종권이 없어요", 403)
    mode = adapter.robots()[robot]["mode"]
    if mode != "idle":
        return refuse(f"mode={mode} — 달리는 중에는 좌표계를 못 바꿔요")
    okey, why = adapter.reset_odom(robot)
    logs.emit(robot, "bridge", "warn" if not okey else "info",
              f"원점 재설정 {'성공' if okey else '실패'} — {why or '지금 자세가 (0,0,0)'}")
    return ok(message=why) if okey else refuse(why or "원점 재설정 실패")


@app.post("/api/robots/{robot}/stop")
async def stop_robot(robot: str):
    if robot not in ROBOT_IDS:
        return refuse("없는 로봇")
    if not procs.stop(robot, reason="stopped"):
        adapter.stop(robot)
    return ok()


# ── 경로 — 웨이포인트 저장·승격 (계약 §경로 · D136) ─────────────────────────
@app.get("/api/paths")
async def get_paths():
    return paths.list()


@app.get("/api/paths/{name}")
async def get_path(name: str):
    doc = paths.get(name)
    return doc if doc else refuse("없는 경로", 404)


@app.put("/api/paths/{name}")
async def put_path(name: str, body: dict):
    if safety.check_name(name):
        return refuse(safety.check_name(name))
    if len(json.dumps(body)) > path_mod.BODY_MAX:
        return refuse("본문 64KB 상한 초과")
    doc, reason = path_mod.validate(body)
    if reason:
        return refuse(reason)
    return paths.save(name, doc)


@app.delete("/api/paths/{name}")
async def delete_path(name: str):
    if safety.check_name(name):
        return refuse(safety.check_name(name))
    return ok() if paths.delete(name) else refuse("없는 경로", 404)


@app.post("/api/paths/{name}/append-here")
async def path_append_here(name: str, body: dict):
    """지금 그 자리를 점 하나로 덧붙인다 — 텔레옵으로 세운 정차 자세를 그대로 굳힌다 (계약 §경로)."""
    if safety.check_name(name):
        return refuse(safety.check_name(name))
    robot = body.get("robot")
    if robot not in ROBOT_IDS:
        return refuse("없는 로봇")
    r = adapter.robots()[robot]
    point, reason = path_mod.point_from_pose(r["pose"], r["poseAgeSec"])
    if reason:
        return refuse(reason)
    doc, reason = paths.append(name, point)
    if reason:
        return refuse(reason)
    logs.emit(robot, "bridge", "info",
              f"경로 {name}: {len(doc['points'])}번째 점 — "
              f"({point['xMm']:.0f}, {point['yMm']:.0f}, {point['thetaDeg']:.0f}°)")
    return ok(name=name, points=len(doc["points"]), added=point)


@app.post("/api/paths/{name}/pop")
async def path_pop(name: str):
    if safety.check_name(name):
        return refuse(safety.check_name(name))
    doc, reason = paths.pop(name)
    return ok(name=name, points=len(doc["points"])) if doc else refuse(reason, 404)


@app.post("/api/paths/{name}/from-run")
async def path_from_run(name: str, body: dict):
    if safety.check_name(name):
        return refuse(safety.check_name(name))
    samples = runs.get_path(body.get("runId") or "")
    if not samples:
        return refuse("그 run 에 궤적이 없어요", 404)
    pts = path_mod.from_run(samples)
    if not pts:
        return refuse("궤적이 너무 짧아 웨이포인트가 안 나와요")
    # frame 은 odom 이다 — 판 좌표를 아직 안 쟀다 (계약 §경로). 재면 여기서 변환한다
    doc, reason = path_mod.validate({"frame": "odom", "points": pts,
                                     "createdFrom": body.get("runId")})
    if reason:
        return refuse(reason)
    return paths.save(name, doc)


# ── 맵·매핑 ─────────────────────────────────────────────────────────────────
@app.get("/api/maps")
async def get_maps():
    return maps.list()


@app.post("/api/maps/{name}/activate")
async def activate_map(name: str, body: dict):
    robot = body.get("robot")
    if robot not in ROBOT_IDS or not maps.exists(name):
        return refuse("없는 로봇 또는 맵", 404)
    adapter.patch(robot, nav="starting")
    adapter.set_active_map(robot, name)

    async def settle():                                   # 재기동은 비동기 — nav 필드로 본다 (감사 O1)
        await asyncio.sleep(1.0)
        adapter.patch(robot, nav="running")
        logs.emit(robot, "nav", "info", f"map activate — {name} · AMCL 재기동")
    asyncio.get_event_loop().create_task(settle())
    return JSONResponse(ok(), status_code=202)


@app.get("/api/maps/live.png")
async def live_png(robot: str):
    if robot not in ROBOT_IDS:
        return refuse("없는 로봇", 404)
    r = adapter.robots()[robot]
    png = map_image.render(adapter.trail(robot), r["pose"])
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.patch("/api/maps/{name}")
async def patch_map(name: str, body: dict):
    meta = maps.patch(name, body.get("mapToLab") or {})
    return meta if meta else refuse("없는 맵", 404)


@app.post("/api/mapping/start")
async def mapping_start(body: dict):
    robot, who = body.get("robot"), body.get("who")
    if not owners.is_owner(robot, who):
        return refuse("조종권이 없어요", 403)
    if adapter.robots()[robot]["mode"] != "idle":
        return refuse(f"mode={adapter.robots()[robot]['mode']} — 시작은 idle 에서만")
    adapter.patch(robot, mode="mapping", nav="starting", _trail=[])   # 새 맵 — 탐색 흔적 리셋

    async def settle():
        await asyncio.sleep(0.8)
        adapter.patch(robot, nav="running")
        logs.emit(robot, "nav", "info", "SLAM 기동 (mock)")
    asyncio.get_event_loop().create_task(settle())
    logs.emit(robot, "bridge", "info", "mapping start")
    return JSONResponse(ok(), status_code=202)


@app.post("/api/mapping/save")
async def mapping_save(body: dict):
    robot, name = body.get("robot"), body.get("name")
    if safety.check_name(name):
        return refuse(safety.check_name(name))
    if adapter.robots()[robot]["mode"] != "mapping":
        return refuse("매핑 중이 아니에요")
    meta = maps.save(name)
    adapter.stop(robot)
    adapter.set_active_map(robot, name)
    logs.emit(robot, "bridge", "info", f"map saved — {name}")
    return ok(map=meta)


@app.post("/api/mapping/stop")
async def mapping_stop(body: dict):
    robot = body.get("robot")
    if adapter.robots()[robot]["mode"] != "mapping":
        return refuse("매핑 중이 아니에요")
    adapter.stop(robot)
    logs.emit(robot, "bridge", "info", "mapping stop (저장 없음)")
    return ok()


# ── 기록 ────────────────────────────────────────────────────────────────────
@app.get("/api/runs")
async def get_runs(robot: str | None = None, slot: str | None = None, limit: int = 100):
    return runs.list(robot, slot, limit)


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    run = runs.get(run_id)
    return run if run else refuse("없는 run", 404)


@app.get("/api/runs/{run_id}/path")
async def get_run_path(run_id: str):
    return runs.get_path(run_id)


@app.patch("/api/runs/{run_id}")
async def patch_run(run_id: str, body: dict):
    run, reason = runs.patch(run_id, body)
    return run if run else refuse(reason)


@app.post("/api/record/start")
async def record_start(body: dict):
    robot = body.get("robot")
    free_gb = shutil.disk_usage(HERE).free / 1e9
    if free_gb < CONFIG.get("disk_min_free_gb", 2):       # 감사 R5 — 자동 삭제 대신 거부
        return refuse(f"디스크 여유 {free_gb:.1f}GB — 임계 미만이라 녹화를 거부해요")
    run_id = adapter.robots().get(robot, {}).get("activeRunId")
    if not run_id:
        return refuse("진행 중인 run 이 없어요")
    bag = f"data/bags/{run_id}"
    runs.set_bag(run_id, bag)
    logs.emit(robot, "bridge", "info", f"rosbag record → {bag} (mock 은 경로만)")
    return ok(bagPath=bag)


@app.post("/api/record/stop")
async def record_stop(body: dict):
    logs.emit(body.get("robot"), "bridge", "info", "rosbag stop")
    return ok()


# ── 1Hz pose 샘플러 — run 경로 (감사 F2) ────────────────────────────────────
@app.on_event("startup")
async def start_sampler():
    async def sample():
        while True:
            for rid, r in adapter.robots().items():
                if r["activeRunId"]:
                    runs.sample_pose(r["activeRunId"], r["pose"])
            await asyncio.sleep(1.0)
    asyncio.get_event_loop().create_task(sample())


# ── 지오펜스 감시 10Hz — 판정은 브리지 하나가 한다 (계약 §지오펜스) ──────────
@app.on_event("startup")
async def start_geofence_watch():
    was_inside = {}

    async def watch():
        while True:
            for rid, r in adapter.robots().items():
                st = fence_state(rid, r)
                if st is None:                            # 지오펜스 미설정 — 판정하지 않는다
                    continue
                if not st["inside"]:
                    if was_inside.get(rid) is not False:   # 전이에서 한 번만 — 매 틱 SIGTERM 은 run 을 두 번 마감한다
                        logs.emit(rid, "bridge", "warn", f"지오펜스 정지 — {st['reason']}")
                        procs.stop(rid, reason="stopped")
                    adapter.stop(rid)                     # cmd_vel 0 은 밖에 있는 동안 매 틱
                elif was_inside.get(rid) is False:
                    logs.emit(rid, "bridge", "info", f"지오펜스 복귀 — 여유 {st['marginMm']}mm")
                was_inside[rid] = st["inside"]
            await asyncio.sleep(0.1)
    asyncio.get_event_loop().create_task(watch())


# ── 정적 서빙 — 빌드된 웹앱. 팀원은 이 주소 하나만 연다 (D29) ────────────────
DIST = HERE.parent / "dist"


# index.html 만 캐시 금지다 (2026-08-19 실측). 배포 뒤 서버는 새 번들을 주는데 브라우저가
# **옛 index.html** 을 캐시해 옛 번호의 js 를 계속 불렀다 — 배포는 됐는데 화면만 어제였다.
# 자산(`/assets/*`)은 파일명에 해시가 박혀 있어 그대로 캐시해도 안전하다. 여기만 막으면 된다.
@app.get("/")
async def index():
    f = DIST / "index.html"
    if not f.exists():
        return JSONResponse({"ok": True, "hint": "터틀봇 화면은 FR5 조작(:5055)의 「터틀봇」 탭이에요 (D182)"})
    return Response(f.read_bytes(), media_type="text/html",
                    headers={"Cache-Control": "no-store"})


if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
