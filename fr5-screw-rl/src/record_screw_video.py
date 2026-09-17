#
# 🎥 실측 기반 나사 체결 정책(fr5_screw_assembly) 재생 + 녹화
#
# 기존 record_fleet_video.py 는 구환경(점 TCP, 3.2cm 성공판정)용이라 그대로 두고,
# 재설계된 환경은 이 스크립트로 시각화한다. 달라진 점:
#   · TCP 위치뿐 아니라 툴 자세(기울기 + 체결 회전각)까지 IK 로 구속한다
#     -> 탄두가 탄피와 동축으로 서고, 체결 중 실제로 축을 중심으로 돌아간다
#   · TCP 높이가 환경에서 결합면에 구속되므로 탄두가 탄피를 관통하지 않는다
#
import os
import re
import glob
import subprocess
import sys

os.environ.setdefault("MUJOCO_GL", "glfw")   # OSMesa 는 torch 와 충돌해 세그폴트

import numpy as np
import mujoco
import mujoco.viewer

import fr5_multi_fleet_control as fc          # FleetViewer(씬 복제/렌더)만 재사용
import fr5_screw_assembly as E
from train_failure_exhibit import SlowSpinEnv

WIDTH, HEIGHT, FPS = 1280, 720, 20
REPLAY_STEPS = int(sys.argv[sys.argv.index("--steps") + 1]) if "--steps" in sys.argv else 300
# 한 제어 스텝을 몇 프레임에 걸쳐 보여줄지.
# 환경의 제어 주기(CONTROL_DT)에서 자동 유도한다. 임의로 고르면 영상 속도가
# 시뮬레이션 시간과 어긋나 '보기에만 그럴듯한' 영상이 된다.
SUBFRAMES = (int(sys.argv[sys.argv.index("--subframes") + 1]) if "--subframes" in sys.argv
             else max(1, round(E.CONTROL_DT * FPS)))
ORI_WEIGHT = 0.10
# 그리퍼 손가락 위치 (m). 0 = 열림, 0.020 = 완전 닫힘.
# [도면] 교육자료 9장 Technical Drawings: 조 간격 MAX 40.80mm ~ MIN 0.80mm
#
# 실물 파지값 17 과 모델값이 다른 이유
#   WebApp 위치 p -> 조 간격 = 0.80 + p/100 x 40.00 mm
#     p=17 -> 7.60mm 인데 탄두 최대 외경은 9.00mm 다. 편측 0.70mm 가 모자란다.
#   검정 고무 핑거가 그만큼 눌린 상태로 무는 것이다. 고무라 가능하고,
#   이 눌림이 마찰을 만들어 파지력 30 으로도 미끄러지지 않는 이유가 된다.
#   모델은 강체라 눌림을 표현할 수 없으므로 역할을 나눈다.
#     시각화   : 간격 9.0mm (손가락이 탄두에 딱 닿게)  <- 여기
#     실물 명령: 위치 17 그대로 (눌림 포함한 실측값)   <- fr5_execute_policy.GRIP_POS
JAW_MAX_GAP = 0.0408                      # [도면] 최대 개방 간격
FINGER_GRIP = (JAW_MAX_GAP - E.BULLET_OD) / 2   # 탄두 Ø9 파지 = 0.0159
FINGER_OPEN = 0.006                       # [추정] 재파지·놓기 — 탄두가 빠질 만큼만
FAILURE_DIR = "./models_failures/"   # 실패 양상 정책 (train_failure_exhibit.py 생성)
SAVE_DIR = (sys.argv[sys.argv.index("--models") + 1]
            if "--models" in sys.argv else "./models_screw/")


class _DummyViewer:
    is_running = lambda self: True
    sync = lambda self: None
    close = lambda self: None


def _disable_interactive_viewer():
    """
    녹화는 오프스크린이므로 대화형 창을 띄우지 않는다.
    ⚠️ 모듈 임포트 시점에 패치하면, 이 모듈을 가져다 쓰는 다른 스크립트
    (verify_screw_policy.py)가 진짜 뷰어를 못 띄운다. main() 안에서만 끈다.
    """
    mujoco.viewer.launch_passive = lambda model, data, **kw: _DummyViewer()


def tool_quat(tilt, spin):
    """툴 자세: 연직 하향(z축 -world z) + 기울기(tx,ty) + 축 회전(체결 회전각)."""
    tx, ty = float(tilt[0]), float(tilt[1])
    cx, sx, cy, sy = np.cos(tx), np.sin(tx), np.cos(ty), np.sin(ty)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    R0 = np.diag([1.0, -1.0, -1.0])            # 툴 z축을 아래로
    cs, ss = np.cos(spin), np.sin(spin)
    Rz = np.array([[cs, -ss, 0], [ss, cs, 0], [0, 0, 1]])
    q = np.zeros(4)
    mujoco.mju_mat2Quat(q, (Rx @ Ry @ R0 @ Rz).flatten())
    return q


class ScrewFleetViewer(fc.FleetViewer):
    """오프스크린 해상도 주입 + 위치·자세 6자유도 IK."""

    def _build_fleet_xml(self, mjcf_path):
        path = super()._build_fleet_xml(mjcf_path)
        xml = open(path, encoding="utf-8").read()
        if "offwidth" not in xml:
            open(path, "w", encoding="utf-8").write(xml.replace(
                "<worldbody>",
                f'<visual><global offwidth="{WIDTH}" offheight="{HEIGHT}"/></visual>\n<worldbody>',
                1))
        return path

    def _solve_ik_pose(self, i, target_pos, q_des, max_iters=80, tol=1e-4,
                       step_gain=0.5, damping=1e-3):
        sid = self.site_ids[i]
        dofs, qadr = self.arm_dofs[i], self.arm_qpos[i]
        jacp, jacr = np.zeros((3, self.model.nv)), np.zeros((3, self.model.nv))
        qc, qi, qe, w = np.zeros(4), np.zeros(4), np.zeros(4), np.zeros(3)
        for _ in range(max_iters):
            mujoco.mj_forward(self.model, self.data)
            err_pos = target_pos - self.data.site_xpos[sid]
            mujoco.mju_mat2Quat(qc, self.data.site_xmat[sid])
            mujoco.mju_negQuat(qi, qc)
            mujoco.mju_mulQuat(qe, q_des, qi)
            mujoco.mju_quat2Vel(w, qe, 1.0)
            err = np.concatenate([err_pos, w * ORI_WEIGHT])
            if np.linalg.norm(err) < tol:
                break
            mujoco.mj_jacSite(self.model, self.data, jacp, jacr, sid)
            jac = np.vstack([jacp[:, dofs], jacr[:, dofs] * ORI_WEIGHT])
            dq = jac.T @ np.linalg.solve(jac @ jac.T + damping * np.eye(6), err)
            self.data.qpos[qadr] = np.clip(self.data.qpos[qadr] + dq * step_gain,
                                           self.jnt_lo[qadr], self.jnt_hi[qadr])

    def _cache_finger_adr(self):
        """그리퍼 손가락 slide 관절의 qpos 주소를 캐싱 (재파지 시 벌리기 위함)."""
        if hasattr(self, "_finger_adr"):
            return
        self._finger_adr = []
        for i in range(self.n_robots):
            adrs = []
            for side in ("right", "left"):
                jid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT,
                                        f"r{i}_finger_{side}_joint")
                adrs.append(int(self.model.jnt_qposadr[jid]) if jid >= 0 else None)
            self._finger_adr.append(adrs)

    def sync_pose(self, ee_positions, quats, casing_positions, finger_open=None,
                  wrist=None):
        """
        wrist 를 주면 체결 회전을 j6 에만 적용한다.

        ⚠️ 체결 회전을 IK 의 목표 자세에 넣으면 안 된다. damped least-squares 는
           회전 오차를 6축에 나눠 배분하므로, j6 만 돌면 되는 상황에서도
           j2~j5 가 같이 흔들린다(화면에서 팔 전체가 움직이는 원인).
           파지중심이 j6 축 위에 있으므로(실측 편심 0mm) j6 회전은 TCP 위치도
           툴의 연직 하향 자세도 바꾸지 않는다. 따라서
             1) 회전 없는 자세로 IK 를 풀어 j1~j6 를 구하고
             2) 렌더링 직전에 j6 만 실제 손목각으로 덮어쓴다
           로 분리하는 것이 물리적으로도 맞다.
           다음 프레임 IK 가 덮어쓴 회전을 되돌리려 하지 않도록 해는 따로 보관한다.
        """
        self._cache_finger_adr()
        if not hasattr(self, "_arm_sol"):
            self._arm_sol = [None] * self.n_robots
        for i in range(self.n_robots):
            frame = self.base_offsets[i] + fc.TASK_FRAME_ORIGIN
            self.data.mocap_pos[self.mocap_ids[i]] = frame + casing_positions[i]
            if self._arm_sol[i] is not None:
                self.data.qpos[self.arm_qpos[i]] = self._arm_sol[i]   # 회전분 제거 후 시작
            self._solve_ik_pose(i, frame + ee_positions[i], quats[i])
            self._arm_sol[i] = self.data.qpos[self.arm_qpos[i]].copy()
            if wrist is not None:
                adr = self.arm_qpos[i][5]
                self.data.qpos[adr] = float(np.clip(wrist[i], self.jnt_lo[adr],
                                                    self.jnt_hi[adr]))
            if finger_open is not None:
                # ⚠️ URDF 정의상 finger_joint = 0 이 '열림', 0.021 이 '완전 닫힘'이다
                #    (SRDF group_state: open=0 / closed=0.021).
                #    이 부호를 뒤집어 쓰면 평소엔 활짝 열려 있고 재파지 때 손가락이
                #    맞닿는, 실제와 정반대 동작이 된다.
                #    파지 시에는 완전히 닫는 것이 아니라 탄두 최대 외경(Ø9)에서 멈춘다.
                #      손가락 안쪽면 초기 간격 42.0mm → joint = (42 - 9)/2 = 16.5mm
                #      WebApp MoveGripper 환산 약 21/100 (실물 파지값 17 과 근사)
                v = FINGER_OPEN if finger_open[i] else FINGER_GRIP
                for adr in self._finger_adr[i]:
                    if adr is not None:
                        self.data.qpos[adr] = v
        mujoco.mj_forward(self.model, self.data)


def make_writer(path):
    return subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", path],
        stdin=subprocess.PIPE)


def build_roster():
    """
    로스터 구성 — 정중앙(금색)은 정상 체결 정책, 좌우 4대는 '서로 다른 실패 양상'.

        왼쪽 ─────────────────────────────────────────────────── 오른쪽
      ① 접근실패   ② 문지름   [ ★ 정상 체결 / 금색 ]   ③ 호버링   ④ 회전부족
       y=-2.4     y=-1.2           y=0.0             y=+1.2     y=+2.4

    같은 학습 실행의 수렴 구간 체크포인트를 4대 늘어놓으면 넷이 똑같이 움직여
    비교 검증의 의미가 없다. 그래서 학습 중 실제로 나타났던 실패 모드를
    하나씩 재현해 둔 정책(models_failures/)을 쓴다.
    양상은 classify_failures.py 로 라벨을 검증한 것들이다.
    """
    from stable_baselines3 import PPO

    def step_of(p):
        # ⚠ 숫자를 이어붙이면 안 된다 — 파일명 끝에 실행 시각이 붙는다
        #   (candidate_250000steps_20260908-1221.zip). `<N>steps` 만 읽는다.
        m = re.search(r"(\d+)steps", os.path.basename(p))
        digits = m.group(1) if m else ""
        return int(digits) if digits else 0

    def score(path, n_episodes=20):
        """성공률 / 평균보상 / jam(결합면 문지름) 스텝 수를 함께 잰다."""
        model = PPO.load(path, device="cpu")
        env = E.FR5ScrewAssemblyEnv()
        succ, rewards, jams = 0, [], []
        for i in range(n_episodes):
            obs, _ = env.reset(seed=5000 + i)
            total, jam = 0.0, 0
            for _ in range(E.MAX_STEPS):
                a, _ = model.predict(obs, deterministic=True)
                obs, r, te, tr, info = env.step(a)
                total += r; jam += bool(info["jammed"])
                if te or tr:
                    break
            succ += bool(info["is_success"]); rewards.append(total); jams.append(jam)
        return succ / n_episodes, float(np.mean(rewards)), float(np.mean(jams))

    # ── 정중앙: 성공률 높고 '문지름(jam)'이 적은 정책을 고른다 ────────────
    cands = sorted(glob.glob(os.path.join(SAVE_DIR, "**", "*.zip"), recursive=True))
    if not cands:
        raise RuntimeError(f"{SAVE_DIR} 에 학습된 모델이 없습니다. train_screw_ppo.py 를 먼저 실행하세요.")

    print("📂 [성능 기준] 체크포인트 재평가 — 실물 이식 대상 선정")
    scored = []
    for path in cands:
        sr, mr, jm = score(path)
        scored.append((sr, -jm, mr, path))
        print(f"   {os.path.relpath(path, SAVE_DIR):<40s} 성공률 {sr*100:5.1f}%  "
              f"문지름 {jm:6.1f}스텝  평균보상 {mr:8.1f}")
    # 성공률 -> 문지름 적은 순 -> 평균보상. 결합면을 비비는 정책은 실물에서
    # 나사산·모서리를 상하게 하므로 성공률이 같으면 반드시 걸러낸다.
    scored.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    best = scored[0][3]
    print(f"   ★ 실물 이식 대상: {os.path.relpath(best, SAVE_DIR)} "
          f"(성공률 {scored[0][0]*100:.1f}%, 문지름 {-scored[0][1]:.1f}스텝)")

    # ── 좌우 4대: 서로 다른 실패 양상 ────────────────────────────────────
    # (라벨, 파일, 그 로봇을 돌릴 환경)
    # ①②③ 은 정책 자체의 실패라 정상 환경에서 그대로 재현된다.
    # ④ 는 '회전 능력이 부족한 툴'이라는 하드웨어 조건이므로 그 환경으로 돌려야
    #    재현된다. (정상 환경에서 평가하면 이 정책도 체결에 성공한다 — 실측 확인)
    exhibits = [("① 접근 실패", "01_wander.zip", E.FR5ScrewAssemblyEnv),
                ("② 문지름", "02_jam.zip", E.FR5ScrewAssemblyEnv),
                ("③ 입구위 호버링", "03_hover.zip", E.FR5ScrewAssemblyEnv),
                ("④ 회전 부족", "04_stall.zip", SlowSpinEnv)]
    missing = [f for _, f, _ in exhibits if not os.path.exists(os.path.join(FAILURE_DIR, f))]
    if missing:
        raise RuntimeError(
            f"{FAILURE_DIR} 에 실패 양상 정책이 없습니다: {missing}\n"
            f"먼저 실행하세요:  python3 train_failure_exhibit.py")

    roster = [(lbl, os.path.join(FAILURE_DIR, f), False, cls) for lbl, f, cls in exhibits[:2]]
    roster.append(("★ 정상 체결", best, True, E.FR5ScrewAssemblyEnv))
    roster += [(lbl, os.path.join(FAILURE_DIR, f), False, cls) for lbl, f, cls in exhibits[2:]]

    # ── 배치 불변식 검증 (발표 문서 4-2 (5) 항의 결함 재발 방지) ──────────
    center_idx = next(i for i, r in enumerate(roster) if r[2])
    ys = [(i - (len(roster) - 1) / 2.0) * fc.FLEET_SPACING for i in range(len(roster))]
    assert len(roster) == 5, f"로봇이 {len(roster)}대입니다. 항상 5대(홀수)여야 합니다."
    assert center_idx == 2 and abs(ys[center_idx]) < 1e-9, \
        f"금색 로봇이 정중앙이 아닙니다 (index={center_idx}, y={ys[center_idx]})"
    used = [os.path.abspath(p) for _, p, _, _ in roster]
    assert len(set(used)) == 5, f"중복 정책이 있습니다: {used}"
    print(f"   ✔ 배치 검증: 총 {len(roster)}대 / 금색 y={ys[center_idx]:+.1f} / 중복 없음")
    return roster, center_idx


def main():
    _disable_interactive_viewer()
    roster, center_idx = build_roster()
    print("\n🎬 [녹화 로스터]")
    for i, (label, path, is_real, _) in enumerate(roster):
        print(f"   {i+1}번 자리: {label:<16s} ({os.path.basename(path)})"
              f"{'  <-- 중앙/금색' if is_real else ''}")

    from stable_baselines3 import PPO
    envs = [cls(env_id=i) for i, (_, _, _, cls) in enumerate(roster)]
    models = [PPO.load(p, device="cpu") for _, p, _, _ in roster]
    obs = [e.reset()[0] for e in envs]   # 시드 고정 없이 무작위 에피소드

    viewer = ScrewFleetViewer(len(roster), fc.resolve_mjcf_path(), highlight_idx=center_idx)
    renderer = mujoco.Renderer(viewer.model, HEIGHT, WIDTH)
    # [2026-09-16] 0.50 / 0.80 에서 낮췄다. 그 값에서는 책상이 252.8/255 로
    #   **거의 완전 포화**해 형상 정보가 사라졌다 — 고정대가 책상에 녹아 보이지 않고
    #   구멍도 식별되지 않았으며, 눈이 부셨다. 색(MJCF)은 건드리지 않고 조명만 낮춘다.
    #   ⚠ 2026-09-08 에 책상 색을 어둡게 바꿨다가 되돌린 적이 있다. 색이 아니라
    #     **노출이 문제**였다. 같은 이유로 색을 다시 만지지 마라.
    viewer.model.vis.headlight.ambient[:] = 0.32
    viewer.model.vis.headlight.diffuse[:] = 0.58

    c = center_idx
    casing = viewer.base_offsets[c] + fc.TASK_FRAME_ORIGIN + envs[c].bullet_casing_pos
    cam_specs = [
        # ═══════════════════════════════════════════════════════════════════
        # 🔒 전체 조망 앵글 — 확정본. 사용자 승인 구도이므로 변경하지 말 것.
        #    (기준: Screenshot from 2026-08-30 17-52-07.png)
        #
        #    로봇 열의 한쪽 끝에서 열을 따라 내려다보는 낮은 원근 앵글.
        #    가까운 로봇이 오른쪽 앞, 나머지가 왼쪽 뒤로 후퇴한다.
        #
        #    [방향] 화면 오른쪽 벡터 right = (f_y, -f_x, 0), f = 카메라 시선 방향
        #      · 그리퍼가 왼쪽에 오려면  right_x = cos(el)·sin(az) > 0 -> az ∈ (0°, 180°)
        #      · 가까운 로봇이 오른쪽에 오려면 cos(az) > 0            -> az ∈ (-90°, 90°)
        #      교집합 az ∈ (0°, 90°) 에서 60° 채택.
        #
        #    [줌] 로봇 5대의 모든 geom 바운딩 구를 투영해 프레임에 들어오는
        #         최소 distance 를 이분 탐색으로 구한 값. 최대 NDC 0.957 (<1.0 이면 안 잘림).
        #         이보다 distance 를 줄이면 오른쪽 앞 로봇이 잘린다.
        # ═══════════════════════════════════════════════════════════════════
        ("screw_wide.mp4", np.array([fc.TASK_FRAME_ORIGIN[0], -1.2, 0.6]),
         2.77, 60, -11),
        # 🔒 클로즈업·매크로도 전체 조망과 같은 규칙을 따른다 — 확정본, 변경 금지.
        #    그리퍼가 화면 왼쪽, 로봇 기둥(베이스)이 오른쪽에 오도록 az ∈ (0°, 90°).
        #    (이전에는 az 215°/205° 라 이 둘만 그리퍼가 오른쪽에 나왔다)
        ("screw_closeup.mp4", casing + np.array([0, 0, 0.040]), 0.26, 40, -12),
        ("screw_macro.mp4",   casing + np.array([0, 0, 0.030]), 0.15, 35, -6),
    ]
    cams, writers = [], []
    for path, lookat, dist, az, el in cam_specs:
        cam = mujoco.MjvCamera()
        cam.lookat[:] = lookat
        cam.distance, cam.azimuth, cam.elevation = dist, az, el
        cams.append(cam); writers.append(make_writer(path))

    succ = [0] * len(roster); eps = [1] * len(roster); best_depth = [0.0] * len(roster)
    prev_regrips = [0] * len(roster)
    regrip_frames = [0] * len(roster)      # 재파지 연출을 유지할 남은 프레임 수
    REGRIP_HOLD = 3
    def _render(pos, tilt, wrist_, fingers_):
        # IK 목표 자세에는 체결 회전을 넣지 않는다(넣으면 팔 전체가 나눠서 돈다).
        # 회전은 sync_pose 가 j6 에만 직접 적용한다.
        quats = [tool_quat(tilt[i], 0.0) for i in range(len(envs))]
        # j6 회전(실물 구조): 끝단을 돌리면 그리퍼가 통째로 돈다.
        # 누적 회전각이 아니라 실제 손목각(±175°)으로 돌려야 j6 가 가동한계에
        # 붙었다 튕기는 현상이 생기지 않는다.
        viewer.sync_pose(pos, quats, [e.bullet_casing_pos for e in envs],
                         finger_open=fingers_, wrist=wrist_)
        for cam, writer in zip(cams, writers):
            renderer.update_scene(viewer.data, cam)
            writer.stdin.write(renderer.render().tobytes())

    rpm = 60.0 / (2 * np.pi / (E.SPIN_SCALE / (SUBFRAMES / FPS)))
    print(f"\n🏁 {len(roster)}대 동시 재생 + 녹화 ({REPLAY_STEPS} 스텝, 앵글 {len(cams)}종)")
    print(f"   재생 속도: 스텝당 {SUBFRAMES}프레임 = {SUBFRAMES/FPS*1000:.0f}ms "
          f"→ 체결 회전 {np.degrees(E.SPIN_SCALE/(SUBFRAMES/FPS)):.0f}°/s ({rpm:.0f} RPM)")
    # ── 에피소드 사이 연출 상태 ──────────────────────────────────────────
    # 에피소드가 끝나자마자 env.reset() 을 하면 탄두가 한 프레임 만에 탄피에서
    # 45mm 순간이동으로 튀어나온다. 300스텝 영상에서 3번 '들락거리는' 것으로 보인다.
    # 실제 공정처럼 [체결 유지] -> [그리퍼 열기] -> [상승] 후에 다음 부품으로 넘어간다.
    # 재파지도 한 프레임에 끝내면 안 된다. j6 는 한 스트로크에 350°(±175°) 밖에 못 돌아서
    # 6.25바퀴를 잠그려면 [그리퍼 열기 -> 손목 되감기 -> 다시 잡기] 를 6~7회 반복해야 하는데,
    # 되감기를 즉시 처리하면 화면에서 그 동작이 아예 보이지 않는다.
    RUN, HOLD, RETRACT, REGRIP = 0, 1, 2, 3
    HOLD_FRAMES, RETRACT_FRAMES = 20, 20
    RG_OPEN, RG_TURN, RG_CLOSE = 2, 6, 2          # 재파지 연출 프레임 배분
    RG_TOTAL = RG_OPEN + RG_TURN + RG_CLOSE
    regrip_t = [0] * len(roster)
    regrip_from = [0.0] * len(roster)
    state = [RUN] * len(roster)
    hold_left = [0] * len(roster)
    retract_from = [None] * len(roster)
    retract_left = [0] * len(roster)
    rpos = [e.robot_ee_pos.copy() for e in envs]      # 렌더용 TCP
    rtilt = [e.tool_tilt.copy() for e in envs]
    rwrist = [e.wrist for e in envs]
    prev_pos = [p.copy() for p in rpos]
    prev_tilt = [t.copy() for t in rtilt]
    prev_wrist = list(rwrist)
    release = [False] * len(roster)                   # 완성품을 놓는 중

    for step in range(REPLAY_STEPS):
        for i, env in enumerate(envs):
            if state[i] == RUN:
                a, _ = models[i].predict(obs[i], deterministic=True)
                obs[i], _, te, tr, info = env.step(a)

                # 금색(실물 이식 대상) 로봇의 행동만 실제 FR5 하드웨어로 포워딩
                if roster[i][2]:
                    fc.send_command_to_real_fr5_robot(a)
                best_depth[i] = max(best_depth[i], info["depth_mm"])
                rpos[i] = env.robot_ee_pos.copy()
                rtilt[i] = env.tool_tilt.copy()
                if info["regrips"] > prev_regrips[i]:
                    # 스트로크 끝(+175°)에 도달 -> 재파지 연출로 전환.
                    # env 는 이미 wrist 를 -175° 로 되돌렸으므로 시작각은 +175° 로 잡는다.
                    prev_regrips[i] = info["regrips"]
                    state[i], regrip_t[i] = REGRIP, 0
                    regrip_from[i] = E.WRIST_LIMIT
                    rwrist[i] = E.WRIST_LIMIT
                else:
                    rwrist[i] = env.wrist
                if te or tr:
                    succ[i] += bool(info["is_success"])
                    state[i], hold_left[i] = HOLD, HOLD_FRAMES

            elif state[i] == REGRIP:
                # [열기] -> [손목 되감기 +175° -> -175°] -> [다시 잡기]
                regrip_t[i] += 1
                t = regrip_t[i]
                if t <= RG_OPEN:
                    rwrist[i] = regrip_from[i]
                elif t <= RG_OPEN + RG_TURN:
                    u = (t - RG_OPEN) / RG_TURN
                    rwrist[i] = regrip_from[i] + (-E.WRIST_LIMIT - regrip_from[i]) * u
                else:
                    rwrist[i] = -E.WRIST_LIMIT
                release[i] = t <= RG_OPEN + RG_TURN     # 되감는 동안 그리퍼를 벌린다
                if t >= RG_TOTAL:
                    state[i], release[i] = RUN, False

            elif state[i] == HOLD:                    # 체결 완료 상태를 잠시 보여준다
                hold_left[i] -= 1
                if hold_left[i] <= 0:
                    state[i] = RETRACT
                    retract_from[i] = rpos[i].copy()
                    retract_left[i] = RETRACT_FRAMES
                    release[i] = True                 # 그리퍼를 열어 완성품을 놓는다

            else:                                     # RETRACT — 열고 천천히 상승
                retract_left[i] -= 1
                t = 1.0 - max(retract_left[i], 0) / RETRACT_FRAMES
                p0 = retract_from[i]
                rpos[i] = np.array([p0[0], p0[1], p0[2] + (E.START_Z - p0[2]) * t])
                if retract_left[i] <= 0:
                    obs[i], _ = env.reset()
                    eps[i] += 1
                    prev_regrips[i] = 0
                    state[i], release[i] = RUN, False
                    rpos[i] = env.robot_ee_pos.copy()
                    rtilt[i] = env.tool_tilt.copy()
                    rwrist[i] = env.wrist

        # ⚠️ 체결 회전을 팔(j6)로 주면 안 된다. 그리퍼 파지중심이 j6 축에서
        #    2.60mm 벗어나 있어(손가락 +31.10 / -26.00mm 비대칭) 탄두가 반경 2.60mm
        #    로 공전한다. 나사산 물림 편심 허용치가 1.00mm 이므로 실물이라면
        #    체결 중 나사산이 뭉개진다. 화면에서 그리퍼 머리가 흔들리던 원인이 이것이다.
        #    -> 팔 자세는 회전 없이(연직 하향) 고정하고, 회전은 파지중심을 지나는
        # 그리퍼는 재파지 되감기 중과 완성품을 놓을 때 벌어진다
        fingers = [release[i] for i in range(len(envs))]

        # 한 제어 스텝을 SUBFRAMES 프레임에 나눠 보간해 그린다.
        # 스텝당 1프레임이면 회전이 95RPM 으로 보여 실제 나사 체결 속도와 맞지 않는다.
        for sub in range(1, SUBFRAMES + 1):
            u = sub / SUBFRAMES
            ip = [prev_pos[i] + (rpos[i] - prev_pos[i]) * u for i in range(len(envs))]
            it = [prev_tilt[i] + (rtilt[i] - prev_tilt[i]) * u for i in range(len(envs))]
            iw = [prev_wrist[i] + (rwrist[i] - prev_wrist[i]) * u for i in range(len(envs))]
            _render(ip, it, iw, fingers)
        prev_pos = [p.copy() for p in rpos]
        prev_tilt = [t.copy() for t in rtilt]
        prev_wrist = list(rwrist)

        if step % 50 == 0:
            e = envs[c]
            print(f"   스텝 {step:3d} | 중앙: 물림={e.engaged} 깊이={e.depth*1000:5.2f}mm "
                  f"편심={e.lateral*1000:5.2f}mm 회전={np.degrees(e.spin):7.0f}° "
                  f"재파지={e.regrips}회")

    for w in writers:
        w.stdin.close(); w.wait()

    print("\n📊 [집계]")
    for i, (label, _, _, _) in enumerate(roster):
        print(f"   {label:<16s} : 체결성공 {succ[i]:2d}회 / 에피소드 {eps[i]-1}회 "
              f"| 최대 체결깊이 {best_depth[i]:.2f}mm")
    print("\n🎉 녹화 완료: " + " / ".join(s[0] for s in cam_specs))


if __name__ == "__main__":
    main()
