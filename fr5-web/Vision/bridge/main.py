# cam-bridge — 손목 D435 의 유일한 관문 (`LAYOUT-METRICS-CONTRACT.md` §카메라가 정본이다.
# 어긋나면 문서부터 고친다). "장치 하나에 관문 하나" — fr5-bridge·tb-bridge 와 같은 모양이다.
#
# 실행: bash scripts/robot/cam-run.sh   배포: bash scripts/deploy/cam-ubuntu.sh
#
# **이 관문은 로봇에 명령하지 않는다** (계약 §카메라 관문은 로봇에 명령하지 않는다).
# 찍고·시각 찍고·요약할 뿐이다. 실행 여부는 언제나 FR5 브리지의 안전 게이트가 정한다.
#
# ## 천장 (`ponytail:`) — 일부러 안 만든 둘
#
# ① **해상도 전환이 없다.** 계약은 접근 848x480 ↔ 근접 424x240 을 오가게 돼 있는데 지금은
#    `config.yaml` 이 정한 한 모드로만 돈다. 전환은 파이프라인 재구성이라 "전환 중 valid:false"
#    를 같이 만들어야 하고, **전환을 부를 주인(제안 생산자)이 아직 없다.** 생기면 그때 연다
# ② **`/api/camera/measure` 와 `/record/*` 가 없다.** measure 는 `pose` 를 내야 하는데 그건
#    손아이 캘리브레이션(카메라→TCP)이 있어야 나온다 — 아직 없다(`Vision/AGENTS.md` §문이
#    열리는 순서). **낼 수 없는 필드를 `null` 로 채운 라우트를 열어 두지 않는다.** 있으면
#    누군가 부르고, `null` 은 "지금은 못 잡았다"로 읽힌다. record 는 저장 경로가 호스트에
#    달려 있다(D61 잔여) — 시연 수집(B축) 차례에 연다
# ③ **기존 `depth/frame`은 컬러와 정렬되지 않는다.** 호환성을 유지하고, 깊이와 컬러를 같이
#    보는 검출기는 `rgbd/frame`의 같은 촬영 묶음만 쓴다(D207).
#
# `depth/frame` 은 2026-08-11 에 열었다 — 컬러 단독 분할이 이 작업물에서 실패하는 것을
# 실측으로 확인했고(정반사 +154% / 그림자 −48%), 깊이를 볼 수단이 없어 **판정 자체가
# 불가능했다**. 근거 `docs/evidence/2026-08-11/round-detect-probe.md`.
from pathlib import Path

import yaml
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from camera import Camera

HERE = Path(__file__).parent
# ⚠ **인코딩을 반드시 적는다.** `read_text()` 는 OS 기본을 쓰는데 한국어 윈도우는 **cp949** 라
# 이 파일의 한글 주석에서 `UnicodeDecodeError` 로 죽는다 — 리눅스(기본 UTF-8)에서는 안 보이던
# 버그가 호스트를 옮기자마자 튀어나왔다 (2026-08-11 · 윈도우 호스트 전환). 관문이 **뜨지도
# 못하고** 죽으므로 얼굴이 "카메라 문제" 처럼 보인다.
CONFIG = yaml.safe_load((HERE / "config.yaml").read_text(encoding="utf-8"))

app = FastAPI()

# **CORS 가 없으면 화면이 못 읽는다.** FR5 화면은 5055 에서 오고 이 관문은 5057 이라 —
# 같은 기계인데도 — 브라우저에는 남의 출처다. 없으면 `fetch` 가 조용히 막히고 화면은
# "카메라 확인 못 함" 을 상주시킨다. 2026-08-06 에 폰 `status.json` 에서 밟은 자리와 같다.
# 여는 범위는 LAN 신뢰 그대로다 — 이 관문은 **읽기뿐이고 로봇에 명령하지 않는다**.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

cam = Camera(CONFIG).start()


@app.get("/api/camera/info")
def info():
    return JSONResponse(cam.describe())


@app.get("/api/camera/state")
def state():
    return JSONResponse(cam.snapshot())


@app.get("/api/camera/preview")
def preview():
    jpeg = cam.preview_jpeg()
    if jpeg is None:
        # **빈 이미지를 200 으로 주지 않는다.** 화면이 "검은 프레임" 을 받으면 카메라가
        # 어두운 것과 구분하지 못한다 — 못 왔으면 못 왔다고 말한다 (제1원칙)
        return JSONResponse({"error": "프레임 없음", "detail": cam.describe()}, status_code=503)
    # 미리보기는 매번 새 프레임이다 — 중간 캐시가 옛 장면을 붙들면 멈춘 걸 못 본다
    return Response(jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/camera/depth/frame")
def depth_frame():
    """계약 §깊이 스냅샷 — 16비트 PNG · 밀리미터 · 무효 0. **단발이고 스트림이 아니다.**

    컬러가 못 푸는 것을 여기서 푼다 — 정반사도 그림자도 **밝기**지 기하가 아니라서
    깊이에는 안 걸린다 (`docs/evidence/2026-08-11/round-detect-probe.md`).
    """
    png = cam.depth_png()
    if png is None:
        # `preview` 와 같은 규약 — 못 왔으면 못 왔다고 말한다. 옛 프레임을 200 으로 주면
        # 검출기가 그것을 지금인 줄 안다 (제1원칙)
        return JSONResponse({"error": "깊이 프레임 없음", "detail": cam.snapshot()["depth"]},
                            status_code=503)
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/camera/rgbd/frame")
def rgbd_frame():
    """같은 frameset의 컬러 화소계 컬러+깊이 ZIP. 둘 중 하나라도 없으면 안 낸다."""
    blob = cam.rgbd_zip()
    if blob is None:
        return JSONResponse({"error": "정렬된 RGB·깊이 묶음 없음",
                             "detail": cam.snapshot()["depth"]}, status_code=503)
    return Response(blob, media_type="application/zip", headers={"Cache-Control": "no-store"})


@app.get("/api/camera/ir/frame")
def ir_frame(which: int = 1):
    """계약 §적외선 원본 — 8비트 PNG. **단발이고 판정에 안 쓴다** (D151).

    깊이가 빈 자리가 **가림인지 매칭 실패인지**를 가르는 창이다 —
      · 원본에 물체가 **안 보인다** → 가림(그리퍼가 자기 시야를 먹는다. 렌즈가 툴 축에서 82mm 옆)
      · 원본에 물체가 **또렷하다** → 스테레오 매칭 실패(황동 정반사)

    처방이 정반대라 이 창이 없으면 못 고른다 — 08-27 에 세운 총알 넷 중 둘이 깊이에
    아예 없었는데(60px 안 화소 0) 그 둘을 갈라 볼 수단이 없었다.
    """
    png = cam.ir_png(which)
    if png is None:
        return JSONResponse({"error": "적외선 프레임 없음",
                             "detail": "config `depth.infrared` 가 비었거나 프레임이 낡았다"},
                            status_code=503)
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.on_event("shutdown")
def _shutdown():
    cam.stop()
