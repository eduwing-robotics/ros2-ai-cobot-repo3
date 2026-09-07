# D435 소유자 — **파이프라인은 이 스레드 하나만 연다.**
#
# 왜 스레드인가: `pipeline.start()` 는 1초 가까이 걸리고 장치는 하나뿐이다. 요청마다 열면
# 두 번째 요청이 자기 자신과 장치를 두고 싸운다. 계속 돌려 두고 **최신 한 장의 요약**만
# 라우트에 넘긴다 — 원본 깊이는 밖으로 안 나간다 (계약 §카메라).
#
# `pyrealsense2` 는 여기서만 import 한다. 판정 규칙은 `depth.py` 에 있고 그쪽은 카메라 없이
# 돈다 — 규칙을 실기에서만 확인하게 되면 규칙이 늦게 틀린다.
import atexit
import threading
import time
from io import BytesIO

import numpy as np
from PIL import Image

import depth as D

# 장치가 없을 때 다시 열어보는 간격. 촘촘히 두면 USB 를 계속 두드려 로그만 채운다
RETRY_S = 3.0
# 이보다 오래된 프레임은 "지금" 이 아니다 — 계약 §못 읽으면 아무 일도 안 일어난다
STALE_S = 1.0
# `wait_for_frames` 마감시각. 이걸 안 주면 USB 가 끊길 때 스레드가 통째로 매달린다
FRAME_TIMEOUT_MS = 2000


class Camera:
    """상태를 들고 있는 것은 이 객체 하나다. 라우트는 `snapshot()` 만 읽는다."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()
        self._stop = threading.Event()
        # 아무것도 못 봤을 때의 값 — **낙관값을 두지 않는다.** 초기값이 `connected: True` 면
        # 기동 직후 잠깐 동안 화면이 "붙었다" 고 말한다
        self.info = None          # 장치 제원. 못 열면 None 이다
        self.frame_at = None      # 카메라가 **찍은** 시각 (epoch 초)
        self.ratios = (0.0, 0.0)
        self.min_z = None
        self.temp_c = None
        self.jpeg = None          # 최신 컬러 미리보기 (bytes)
        # **컬러는 깊이와 따로 늙는다.** 둘은 같은 USB 를 나눠 쓰는 다른 센서라 대역이
        # 빡빡하면 컬러가 먼저 떨어지는데, 그동안 깊이는 계속 와서 `frame_at` 이 갱신된다 —
        # 화면은 "다 정상" 이라 말하면서 **30분 전 사진**을 보여주게 된다. 시각을 따로 든다
        self.jpeg_at = None
        # 계약 §깊이 스냅샷 — 최신 한 장의 **정리된** 밀리미터 정수 배열. 848×480 uint16 이
        # 814KB 라 한 장은 들고 있어도 된다. PNG 인코딩은 요청이 올 때만 한다 — 매 프레임
        # 굽는 것은 아무도 안 부르면 통째로 낭비다
        self.depth_mm = None
        # 계약 §적외선 원본 — 스테레오 두 이미저의 **원본 흑백**. 깊이가 빈 자리가
        # **가림인지 매칭 실패인지**를 가르는 창이다 (D151). 판정에는 안 쓴다
        self.ir = {}              # {1: ndarray uint8, 2: ...} · 없으면 빈 dict
        self.error = None         # 마지막으로 못 연 이유. 사람이 읽는다
        # 노브를 못 건 사유. **비어 있는 것이 정상**이고, 차 있으면 화면이 읽어야 한다 —
        # 조용히 실패한 튜닝은 "왜 이 세션만 깊이가 나쁜가" 로 돌아온다
        self.tuning_notes = []
        self._pipe = None         # 아래 §끊고 나가기 — 죽을 때 이걸 직접 닫는다
        # 후처리 필터 — **스냅샷에만** 건다 (유효율은 원본으로 잰다 · D150). 세션마다 새로 만든다:
        # `temporal` 은 프레임 사이 상태를 들고 있어서 파이프라인이 다시 열리면 옛 상태가 거짓이 된다
        self._filters = []
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()
        atexit.register(self.stop)
        return self

    def stop(self):
        """**끊고 나간다.** 데몬 스레드는 인터프리터가 안 기다려 주므로 `_session` 의
        `finally: pipe.stop()` 이 프로세스 종료 때 안 돈다 — 장치를 쥔 채로 죽는다.
        그 상태로 다음 판이 열면 `Protocol error` 가 나고, 그 얼굴은 커널·udev 탓처럼
        보인다 (2026-08-07 실기에서 이 오진에 한 판을 썼다). 여기서 직접 닫는다."""
        self._stop.set()
        pipe, self._pipe = self._pipe, None
        if pipe is not None:
            try:
                pipe.stop()
            except Exception:           # noqa: BLE001 — 이미 닫혔으면 그만이다
                pass

    # ── 밖에서 보는 면 ────────────────────────────────────────────────────────
    def snapshot(self):
        """계약 `GET /api/camera/state` 의 본문. **판정까지 여기서 끝낸다** —
        비율만 넘기고 클라이언트가 판정하게 두지 않는다 (계약 §서버가 싣는다)."""
        with self.lock:
            info, at, (whole, center) = self.info, self.frame_at, self.ratios
            min_z, temp, err = self.min_z, self.temp_c, self.error
            notes = list(self.tuning_notes)
        now = time.time()
        res = self.cfg["depth"]["resolution"]

        if info is None:
            valid, reason = False, D.NO_CAMERA
        elif at is None or now - at > STALE_S or min_z is None:
            # 해상도를 모르면(Min-Z 표에 없으면) 비율 자체가 뜻이 없다 — 프레임이 없는 것과 같다
            valid, reason = False, D.NO_FRAME
        else:
            valid, reason = D.judge(center, self.cfg["depth"].get("valid_ratio_center_min"))

        # **옛 비율을 지금 비율인 척 싣지 않는다** (2026-08-07 실기에서 봤다 — 카메라를 뽑았는데
        # `validRatioCenter 0.945` 가 그대로 남아 있었다). `valid:false` 를 안 보고 비율만 읽는
        # 소비자가 생기면 그 순간 죽은 카메라가 "94.5% 좋음" 으로 읽힌다 — D83 이 MJPEG 에서
        # 잡은 것과 **같은 죄**다. 프레임이 없으면 비율도 없다.
        if reason in (D.NO_CAMERA, D.NO_FRAME):
            whole = center = 0.0

        return {
            "t": now,
            "cameraId": self.cfg["camera_id"],
            "connected": info is not None,
            "usb": info["usb"] if info else None,
            "depth": {
                "resolution": res,
                "fps": self.cfg["depth"]["fps"],
                "minZmm": min_z,
                "valid": valid,
                "validRatio": whole,
                "validRatioCenter": center,
                "validReason": reason,
                # 노브를 못 건 사유. **비어 있는 것이 정상**이다 — 차 있으면 이 세션의 깊이가
                # 설정대로가 아니라는 뜻이라 화면이 읽어야 한다 (계약 §깊이 노브)
                "tuningNotes": notes,
            },
            "lastFrameAt": at,
            "clock": "bridge",
            # 관문이 FR5 브리지와 **같은 기계**에 있으면 차이가 0 인 게 정의다. 다른 기계로
            # 옮기면 `clock_peer` 를 적고 실제로 재야 한다 — 그전까지 `None` 이고, 위 계약대로
            # 못 재는 상태는 통과가 아니다
            "clockSkewMs": 0 if self.cfg.get("clock_peer") is None else None,
            "tempC": temp,
            "error": err,
        }

    def preview_jpeg(self):
        """**낡은 사진은 주지 않는다.** 옛 프레임을 200 으로 내주면 화면은 그것이 지금인 줄
        안다 — D83 이 MJPEG 에서 잡은 것과 같은 죄고, 깊이 비율에서 한 번 밟았다(2026-08-07)."""
        with self.lock:
            jpeg, at = self.jpeg, self.jpeg_at
        if jpeg is None or at is None or time.time() - at > STALE_S:
            return None
        return jpeg

    def depth_png(self):
        """계약 §깊이 스냅샷 — 16비트 PNG(밀리미터 · 무효 0) 또는 `None`.

        **단발이다.** 스트림이 아니라 "지금 한 장" 이고, 낡으면 `preview` 와 같이 안 준다 —
        깊이가 멎은 줄 모르고 옛 프레임으로 검출을 짜면 그 검출이 언제 것인지 아무도 모른다.
        **컬러와 정렬돼 있지 않다** (계약) — 겹치려면 `rs.align` 이 선행이다.
        """
        with self.lock:
            z, at = self.depth_mm, self.frame_at
        if z is None or at is None or time.time() - at > STALE_S:
            return None
        buf = BytesIO()
        Image.fromarray(z).save(buf, "PNG")      # uint16 → mode `I;16` · 무손실
        return buf.getvalue()

    def ir_png(self, which=1):
        """계약 §적외선 원본 — 8비트 PNG 또는 `None`.

        **낡으면 안 준다** — `depth_png` 와 같은 규약이다. 깊이가 멎은 줄 모르고 옛 IR 로
        「가림이었다」를 판정하면 그 판정이 언제 것인지 아무도 모른다.
        ⛔ **판정에 안 쓴다.** 유효율은 여전히 깊이 원본이 낸다 — 여기는 사람이 원인을
        가르는 창이다 (계약 §적외선 원본).
        """
        with self.lock:
            img, at = self.ir.get(int(which)), self.frame_at
        if img is None or at is None or time.time() - at > STALE_S:
            return None
        buf = BytesIO()
        Image.fromarray(img).save(buf, "PNG")
        return buf.getvalue()

    def describe(self):
        """계약 `GET /api/camera/info`."""
        with self.lock:
            info, err = self.info, self.error
        if info is None:
            return {"connected": False, "error": err}
        return {
            "connected": True,
            "model": info["model"],
            "serial": info["serial"],
            "firmware": info["firmware"],
            "usb": info["usb"],
            # **이 프레임이 어느 캘리브레이션에서 나왔나** — 그것뿐이다 (계약 §`calibId` 는
            # 프레임 출처 참조 하나다 · D145). 손목 변환이 됐나는 **다른 질문**이고 FR5
            # 브리지의 `/state.handEye` 가 답한다. 한 필드가 두 뜻이면 한쪽을 고칠 때
            # 다른 쪽이 조용히 틀어진다 — 2026-08-27 까지 실제로 그랬다.
            #
            # 값은 **관문이 이미 아는 것**으로만 짓는다. `config.yaml` 을 읽으러 가지 않는다 —
            # 그 파일은 다른 프로세스·다른 포트의 것이고, 읽게 만들면 배포가 파일 하나를
            # 빠뜨렸을 때 조용히 죽는 면이 하나 더 생긴다
            "calibId": f"d435-{info['serial']}-fw{info['firmware']}",
            # ⭐ **장치가 낸 깊이 내부 파라미터** — 소비처가 화각에서 유도하거나 옛 텍스트
            # 파일을 손으로 읽을 이유를 없앤다. 해상도를 바꾸면 이 값도 같이 바뀐다.
            # 못 읽으면 `null` 이다 — **지어내지 않는다** (계약 §낼 수 없는 필드를 null 로)
            "depthIntrinsics": info.get("depthIntrinsics"),
        }

    # ── 스레드 ───────────────────────────────────────────────────────────────
    def _run(self):
        while not self._stop.is_set():
            try:
                self._session()
            except Exception as e:                       # noqa: BLE001 — 무엇이 나오든 다시 연다
                with self.lock:
                    self.info = None
                    self.frame_at = None
                    self.error = f"{type(e).__name__}: {e}"
            self._stop.wait(RETRY_S)

    def _session(self):
        import pyrealsense2 as rs                        # 이 파일 밖으로 새지 않게 여기서 연다

        dcfg = self.cfg["depth"]
        ccfg = self.cfg["color"]
        w, h = (int(v) for v in dcfg["resolution"].split("x"))
        cw, ch = (int(v) for v in ccfg["resolution"].split("x"))

        conf = rs.config()
        conf.enable_stream(rs.stream.depth, w, h, rs.format.z16, int(dcfg["fps"]))
        conf.enable_stream(rs.stream.color, cw, ch, rs.format.rgb8, int(ccfg["fps"]))
        # 적외선 원본 — **설정으로 켠다**(기본 꺼짐). 깊이와 같은 이미저·같은 해상도라
        # 추가 대역이 작고, 켜면 「깊이가 빈 자리에 물건이 있었나」를 사람이 볼 수 있다
        for which in (dcfg.get("infrared") or []):
            conf.enable_stream(rs.stream.infrared, int(which), w, h, rs.format.y8, int(dcfg["fps"]))
        pipe = rs.pipeline()
        profile = pipe.start(conf)
        self._pipe = pipe          # `stop()` 이 밖에서 닫을 수 있게 — 위 §끊고 나가기
        try:
            dev = profile.get_device()
            sensor = dev.first_depth_sensor()
            # ⚠ **노브를 먼저 건다.** `tuning.depth_units` 가 깊이 스케일 자체를 바꾸므로
            # 스케일을 먼저 읽으면 **모든 mm 값이 조용히 틀린다** — 프레임은 멀쩡해 보이고
            # 숫자만 10배 어긋난다. 순서가 곧 정확도다
            self._apply_tuning(rs, dev, sensor)
            # ⚠ **필터는 노브 뒤에 만든다.** `_apply_tuning` 이 첫 줄에서 `tuning_notes` 를
            # 통째로 비우므로, 앞에 두면 「필터 걸었다」 메모가 지워진다 — 2026-08-27 에
            # 실제로 그랬고 `tuningNotes: []` 라 **필터가 안 걸린 줄 알았다.**
            # 조용한 실패를 잡으려는 필드가 순서 하나로 스스로 조용해지는 자리다
            self._filters = self._build_filters(rs)
            # **깊이 단위는 기기에서 읽는다.** 0.001 로 박으면 다른 개체에서 조용히 틀린다
            scale_mm = sensor.get_depth_scale() * 1000.0
            # 프레임 시각을 호스트 epoch 로 받는다. 이게 꺼져 있으면 `get_timestamp()` 가
            # 장치 부팅 이후 시간이라 **촬영 시각이 아니라 숫자**가 된다
            if sensor.supports(rs.option.global_time_enabled):
                sensor.set_option(rs.option.global_time_enabled, 1)

            with self.lock:
                self.info = {
                    "model": dev.get_info(rs.camera_info.name),
                    "serial": dev.get_info(rs.camera_info.serial_number),
                    "firmware": dev.get_info(rs.camera_info.firmware_version),
                    "usb": dev.get_info(rs.camera_info.usb_type_descriptor),
                    # ⭐ **내부 파라미터는 장치가 정본이다** (2026-08-27 추가). 그전에는
                    # 소비처가 `docs/evidence/2026-08-05/cam/intrinsics.txt` 를 손으로 읽거나
                    # 화각에서 유도했는데, 유도값은 **주점이 3~7화소 틀렸고**(cx 424 vs 427.0 ·
                    # cy 240 vs 247.3) 해상도를 바꾸면 통째로 다시 적어야 했다.
                    # 관문이 내면 소비처가 추측할 이유가 없다 (제1원칙)
                    "depthIntrinsics": self._intr(profile, rs),
                }
                self.min_z = D.min_z_mm(self.cfg["min_z_mm"], dcfg["resolution"])
                self.error = None

            while not self._stop.is_set():
                frames = pipe.wait_for_frames(FRAME_TIMEOUT_MS)
                self._absorb(rs, frames, scale_mm, sensor)
        finally:
            self._pipe = None
            try:
                pipe.stop()
            except Exception:           # noqa: BLE001 — `stop()` 이 먼저 닫았을 수 있다
                pass


    def _intr(self, profile, rs):
        """깊이 스트림의 내부 파라미터. 못 읽으면 `None` — **지어내지 않는다.**"""
        try:
            v = profile.get_stream(rs.stream.depth).as_video_stream_profile().get_intrinsics()
            return {"widthPx": v.width, "heightPx": v.height,
                    "fx": v.fx, "fy": v.fy, "ppx": v.ppx, "ppy": v.ppy,
                    "model": str(v.model), "coeffs": list(v.coeffs)}
        except Exception:                                # noqa: BLE001
            return None

    def _apply_tuning(self, rs, dev, sensor):
        """`config.yaml` §tuning 을 장치에 건다. 등재는 `STACK.md` §깊이 노브.

        **매 세션마다 다시 건다.** 장치가 빠졌다 들어오면 값이 기본으로 돌아가는데, "한 번
        걸었다" 를 상태로 삼으면 그 뒤로 아무도 안 본다 (조건 26 과 같은 태도).
        `null` 은 **건드리지 않는다** — 0 을 넣는 것과 다르다. 못 걸면 **사유를 남기고 계속
        간다**: 노브는 품질을 올리는 것이지 관문이 서는 조건이 아니다.
        """
        # ⚠ **여기서 비운다.** 예전엔 이 뒤 `_session` 의 lock 블록이 비웠는데, 그러면
        # 방금 적은 사유가 통째로 지워졌다 — **조용한 실패를 잡으려던 필드가 스스로 조용해진다**
        # (2026-08-11 자기리뷰에서 잡았다). 세션마다 새로 거니 시작이 비울 자리다.
        with self.lock:
            self.tuning_notes = []
        t = self.cfg.get("tuning") or {}
        # ⚠ **노출·게인이 오래 빠져 있었다** (2026-08-27 추가). 08-11 노브 넷은 「깊이 자체의
        # 설정」만 봤고 **「센서를 어떻게 노출시키나」는 안 봤다** — 반짝이는 황동은 노출이
        # 과하면 포화되고 부족하면 스테레오가 못 매칭한다. 정반사 표면에서는 이게 지배항일 수 있다.
        # ⛔ `enable_auto_exposure` 를 **먼저** 건다 — 자동이 켜져 있으면 `exposure`·`gain` 을
        # 넣어도 다음 프레임에 덮인다(조용히 안 걸린다).
        for name in ("enable_auto_exposure", "exposure", "gain",
                     "laser_power", "visual_preset", "depth_units"):
            v = t.get(name)
            if v is None:
                continue
            opt = getattr(rs.option, name)
            if not sensor.supports(opt):
                self.tuning_notes.append(f"{name}: 미지원")
                continue
            try:
                sensor.set_option(opt, float(v))
            except Exception as e:                       # noqa: BLE001 — 범위 밖이면 여기서 걸린다
                self.tuning_notes.append(f"{name}: {type(e).__name__}")

        shift = t.get("disparity_shift")
        if shift is None:
            return
        # ⚠ shift 를 0 이 아닌 값으로 두면 `min_z_mm` 표가 무효다 (STACK.md). 코드가 그 판정을
        # 대신하지 않는다 — 표를 다시 실측하는 것은 사람 일이다. 여기서는 **건 사실만 남긴다**
        try:
            adv = rs.rs400_advanced_mode(dev)
            if not adv.is_enabled():
                self.tuning_notes.append("disparity_shift: advanced_mode 꺼짐")
                return
            tab = adv.get_depth_table()
            tab.disparityShift = int(shift)
            adv.set_depth_table(tab)
        except Exception as e:                           # noqa: BLE001
            self.tuning_notes.append(f"disparity_shift: {type(e).__name__}")


    def _build_filters(self, rs):
        """후처리 필터를 **설정대로** 만든다. 설정이 없으면 빈 목록 = 안 건다 (D29).

        ⛔ **판정에는 안 쓴다.** 아래 `_absorb` 가 유효율(`validRatio`)을 **원본**으로 재고
        필터본은 **스냅샷(`depth/frame`)에만** 얹는다. 이유는 하나 —

          `hole_filling` 은 **없는 값을 지어낸다.** 그걸로 유효율을 재면 「깊이가 잘 나온다」가
          거짓이 되고, 사각지대 판정(계약 §서버가 싣는다)이 통째로 무너진다. 08-27 에 받침
          영역 **21%가 무효**였는데, 그 21% 를 메워 놓고 「유효 100%」라고 말하는 순간
          **못 보는 자리를 본다고 말하는 화면**이 된다 — 이 프로젝트가 제일 싫어하는 고장이다.

        그래서 계약이 갈린다: **비율은 원본 · 검출은 필터본.** 둘이 다른 값을 보는 것이
        의도이고, 그 사실을 `tuningNotes` 로 화면에 알린다.
        """
        want = self.cfg.get("depth", {}).get("filters") or []
        out = []
        for name in want:
            try:
                if name == "decimation":
                    out.append(("decimation", rs.decimation_filter()))
                elif name == "spatial":
                    f = rs.spatial_filter()
                    # ⛔ `holes_fill` 은 0 으로 둔다 — 이 필터도 메울 수 있다. 메우기는
                    #    `hole_filling` 하나로 모아 **켰는지 한 곳에서 보이게** 한다
                    f.set_option(rs.option.holes_fill, 0)
                    out.append(("spatial", f))
                elif name == "temporal":
                    # ⭐ 반짝이는 금속(황동 탄피)은 **프레임마다 다른 곳이 빠진다** —
                    #    시간축 평균이 그걸 메운다. 지어내는 게 아니라 **본 적 있는 값**이다
                    out.append(("temporal", rs.temporal_filter()))
                elif name == "hole_filling":
                    out.append(("hole_filling", rs.hole_filling_filter()))
                else:
                    self.tuning_notes.append(f"모르는 필터: {name}")
            except Exception as e:                       # noqa: BLE001
                self.tuning_notes.append(f"필터 {name}: {type(e).__name__}")
        if out:
            self.tuning_notes.append("필터(스냅샷 전용) " + "·".join(n for n, _ in out))
        return out

    def _absorb(self, rs, frames, scale_mm, sensor):
        dframe = frames.get_depth_frame()
        cframe = frames.get_color_frame()
        if not dframe:
            return
        z = np.asanyarray(dframe.get_data()).astype(np.float32) * scale_mm
        min_z = self.min_z
        max_mm = self.cfg.get("max_mm", D.DEFAULT_MAX_MM)
        # ⛔ **유효율은 원본으로 잰다** (2026-08-27 · D150). 필터본으로 재면 `hole_filling` 이
        # 지어낸 화소까지 「유효」로 세어 사각지대 판정이 거짓이 된다 — 못 보는 자리를
        # 본다고 말하는 화면이 된다
        ratios = D.valid_ratios(z, min_z, max_mm) if min_z is not None else (0.0, 0.0)
        # 스냅샷(`depth/frame`)에는 **필터본**을 얹는다 — 검출이 쓰는 값이다.
        # 반짝이는 금속은 프레임마다 다른 곳이 빠지고, `temporal` 이 그걸 메운다
        zf = z
        for _name, f in (self._filters or []):
            try:
                zf = None if zf is None else f.process(dframe)
                dframe = zf
            except Exception:                            # noqa: BLE001 — 하나 실패해도 원본으로 간다
                dframe = None
                break
        zf = (np.asanyarray(dframe.get_data()).astype(np.float32) * scale_mm
              if dframe is not None else z)
        # 비율과 **같은 규칙**으로 비운다 (계약 §깊이 스냅샷). Min-Z 를 모르면 `None` 이라
        # 스냅샷도 안 나간다 — 비율이 fail-closed 인데 스냅샷만 나가면 판정이 갈린다
        clean = D.clean_mm(zf, min_z, max_mm)

        at = self._stamp(rs, dframe)
        # **컬러 시각은 따로 찍는다** — 깊이 것을 물려 쓰면 컬러가 멎어도 사진이 안 늙는다.
        # 그게 이 파일에서 고치려는 바로 그 버그다
        jpeg = self._encode(cframe) if cframe else None
        jpeg_at = self._stamp(rs, cframe) if cframe else None
        ir = {}
        for which in (self.cfg["depth"].get("infrared") or []):
            f = frames.get_infrared_frame(int(which))
            if f:
                ir[int(which)] = np.asanyarray(f.get_data()).copy()
        temp = None
        if sensor.supports(rs.option.asic_temperature):
            temp = round(float(sensor.get_option(rs.option.asic_temperature)), 1)

        with self.lock:
            self.frame_at = at
            self.ratios = ratios
            self.depth_mm = clean
            self.ir = ir
            if jpeg is not None:
                self.jpeg = jpeg
                self.jpeg_at = jpeg_at
            self.temp_c = temp

    @staticmethod
    def _stamp(rs, frame):
        """**도착 시각이 아니라 촬영 시각**이다 (계약 §타임스탬프). 전역시각이 켜져 있으면
        `get_timestamp()` 가 호스트 epoch ms 다. 아니면 장치 시계라 우리 시계와 못 짝짓는다 —
        낡음 판정이 통째로 틀리느니 지금 시각을 쓰되, 그건 규약을 못 지킨 상태다."""
        if frame.get_frame_timestamp_domain() == rs.timestamp_domain.global_time:
            return frame.get_timestamp() / 1000.0
        return time.time()

    def _encode(self, cframe):
        """미리보기용 압축 컬러. **원본을 흘리지 않는다** (계약 §실시간 경로는 압축 컬러뿐)."""
        img = Image.fromarray(np.asanyarray(cframe.get_data()))
        want = int(self.cfg["color"].get("preview_width", 424))
        if img.width > want:
            img = img.resize((want, round(img.height * want / img.width)))
        buf = BytesIO()
        img.save(buf, "JPEG", quality=int(self.cfg["color"].get("preview_quality", 70)))
        return buf.getvalue()
