#
# ══════════════════════════════════════════════════════════════════════════════
#  ⚠️  이 파일의 값은 실물 FR5 로봇에서 그대로 실행된다
# ══════════════════════════════════════════════════════════════════════════════
#
#  원칙
#    1. 실물에 관한 값은 임의로 정하지 않는다.
#       치수·속도·힘·좌표는 실측하거나 공식 문서에 근거해야 한다.
#       근거가 없으면 값을 넣지 말고 먼저 물어본다.
#
#    2. 근거 없는 값을 부득이 쓸 때는 반드시 [추정] 으로 표시하고,
#       무엇을 근거로 잡았는지 함께 적는다. 실측되면 즉시 교체한다.
#
#    3. 시험용으로 넣은 것은 되돌릴 때 완전히 제거한다.
#       모델·시각화·실물 명령 세 곳이 항상 같은 값을 가리켜야 한다.
#       (실제 사고: 시뮬 파지 폭만 고치고 실물 명령은 완전 닫힘으로 방치)
#
#    4. 실물 구조에 대한 가정이 들어가는 변경은 먼저 확인을 받는다.
#       (실제 사고: 회전형 엔드이펙터를 임의로 모델에 추가)
#
#  현재 값의 근거는 각 상수 옆 주석과 보고서 '실물 전송 값 점검표' 참조.
#
#
# 🤖 학습된 나사 체결 정책을 실물 FR5 로 '동기 실행'하는 진입점
#
# 설계 원칙 (교육자료 11·14장 반영)
#   1. 스텝 단위 스트리밍 금지
#        정책은 스텝당 4mm 델타를 300번 낸다. 이걸 완료 확인 없이 그대로 보내면
#        팔이 도착하기 전에 다음 명령이 실행된다(그리퍼가 먼저 닫히는 실패).
#        -> 시뮬에서 궤적을 먼저 굴리고, 웨이포인트로 압축해 하나씩 완료 확인하며 보낸다.
#   2. MoveL 금지
#        ros2_cmd_server 세그폴트 확정 명령이라 직교 직선이동을 쓸 수 없다.
#        -> 목표 직교자세를 MuJoCo IK 로 관절각으로 바꿔 MoveJ 로 보낸다.
#   3. 손목 가동범위(j6 ±175°) 준수
#        체결에 6.25바퀴가 필요한데 한 스트로크는 0.956바퀴(344°)뿐이다.
#        -> 스트로크마다 '그리퍼 열기 -> j6 되감기 -> 닫기' 재파지를 실제로 수행한다.
#   4. 기본은 dry-run
#        --move 로 호버까지만, --grasp 로 전체 수행. (교육자료 14장의 안전 설계)
#
# 사용:
#   python3 fr5_execute_policy.py                 # dry-run, 명령 시퀀스만 출력
#   python3 fr5_execute_policy.py --move          # 실물, 호버 위치까지만
#   python3 fr5_execute_policy.py --grasp         # 실물, 체결 전체 수행
#
import os
import sys

import numpy as np
import mujoco

import fr5_screw_assembly as E
import fr5_site as SITE
import selfcheck
from fr5_real_bridge import FR5Bridge, FR5CommandError, FR5SafetyError

MJCF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fairino5_v6_mjmodel.xml")

# 첫 이동 경로를 몇 점으로 훑나. FR5Web 브리지가 13점을 쓴다 — 여기는 이동이 길 수
# 있어 넉넉히 잡는다. 기하 계산이라 비용은 무시할 만하다 (25점에 수십 ms).
PATH_SCAN_SAMPLES = 25
POLICY_DIR = "./models_screw/"

# ── 시작 자세 거리 제한 — **실측 자세에서 얼마나 벗어났나** ────────────────
# 경로 검사(scan_joint_path)는 거리를 안 본다. 관통만 본다. 실제로 재보니 TCP 가
# 1.2m 떨어진 무작위 자세도 97% 가 통과했다 (2026-09-08). 통과한다고 안전한 것이
# 아니라, **MoveJ 는 관절 보간이라 멀리서 출발하면 팔이 크게 휘돈다.** 씬에 없는
# 물건(사람·치구·케이블)은 아무도 안 본다. 그래서 거리로도 막는다.
#
# 기준점은 지어낸 값이 아니라 **실측 자세**다 — fr5_site.HOME_JOINTS_DEG:
#   탄두를 물고(17%) 나사 선단을 탄피 결합면 중심에 얹은 상태에서 읽은 관절각이고,
#   task_origin.json 의 (-274.0, -654.8, -79.9)mm 가 바로 이 자세에서 나왔다.
#   go_home.py 가 되돌리는 자세도 이것이라, 정상 운용이면 거리는 0 에 가깝다.
#
# ⚠ 로봇이 표시하는 TCP 값과 섞지 마라. toolcoord 설정에 따라 달라진다.
#   양쪽 다 **관절각을 MuJoCo FK 로 돌려** 같은 자로 재야 한다.
# ── j6(손목 마지막 축) 허용 영역 — 책상 위에 세운 직육면체 ─────────────────
# **구가 아니라 상자다.** 위로는 길게 열어두고 옆으로만 좁게 막아야 하는데,
# 거리 하나로는 그 모양이 안 나온다. 그리고 기준을 TCP 가 아니라 j6 로 잡는 이유는,
# TCP 는 툴 오프셋·물린 탄두에 따라 달라지는 계산값이지만 j6 은 팔 자체의 위치라
# 흔들리지 않기 때문이다.
#
#   가로  탄피 중심에서 옆으로 / 몸체 쪽으로 ±300mm
#   높이  책상 상면 위 20mm ~ 700mm
#
# ⚠ j6 은 그리퍼+탄두 길이(265mm)만큼 위에 있다. 그래서 정상 자세에서도 탄피와
#   306.5mm 떨어져 있다 — **거리로 재면 안 되고** 이 상자로 재야 한다.
#   실측(2026-09-08) 작업 중 j6 범위: 탄피대비 수평 ±2mm / 책상 위 343~499mm
J6_BOX_HALF_XY_MM = 300.0    # 옆으로·몸체 쪽으로
J6_BOX_Z_MIN_MM   = 20.0     # 책상 상면 위 (하한 — 책상 위 2cm)
J6_BOX_Z_MAX_MM   = 700.0    # 책상 상면 위 (상한)

# 책상 위 이 높이 아래로는 **그리퍼**가 못 내려간다. 탄두는 예외다 (selfcheck 주석 참조).
#   실측(2026-09-08): 책상 상면 -26.4mm / 금지선 -6.4mm / 작업 중 최저점 +44.3mm
DESK_CLEAR_MM = 20.0


def pick_policy(save_dir=POLICY_DIR, n_episodes=10):
    """
    실물로 보낼 정책은 '최종 체크포인트'가 아니라 성능 기준으로 고른다.
    PPO 는 실행 편차가 커서 최종 시점이 중간보다 나쁠 수 있다
    (실측: 275k 90% -> 300k 70%). 성공률 우선, 같으면 문지름이 적은 쪽.
    """
    import glob
    from stable_baselines3 import PPO
    best = None
    for path in sorted(glob.glob(os.path.join(save_dir, "**", "*.zip"), recursive=True)):
        model = PPO.load(path, device="cpu")
        env = E.FR5ScrewAssemblyEnv()
        succ, jam = 0, []
        for i in range(n_episodes):
            obs, _ = env.reset(seed=5000 + i)
            for _ in range(E.MAX_STEPS):
                a, _ = model.predict(obs, deterministic=True)
                obs, _, te, tr, info = env.step(a)
                if te or tr:
                    break
            succ += bool(info["is_success"]); jam.append(info["jam_steps"])
        score = (succ / n_episodes, -float(np.mean(jam)))
        if best is None or score > best[0]:
            best = (score, path)
    if best is None:
        raise SystemExit(f"{save_dir} 에 학습된 정책이 없습니다.")
    return best[1], best[0]

# ── ⚠️ 작업 원점: 반드시 실측으로 채워야 하는 값 ──────────────────────────
# 학습 좌표계는 '탄피 중심이 원점 위 0.1m' 인 국소 좌표계다.
# 실물에서 탄피가 놓인 지점의 로봇 base 좌표(mm)를 여기에 넣어야 한다.
# 구하는 방법 (택1)
#   a) WebApp Jog 로 그리퍼를 탄피 중심에 맞추고 표시되는 X/Y/Z 를 읽는다
#   b) 비전을 쓴다면 교육자료 14장의 P_robot = R @ P_camera + t 결과를 넣는다
# 이 값이 틀리면 그 오차가 그대로 삽입 위치 오차가 된다.
def _load_task_origin():
    """task_origin.json (fr5_calibrate_task_origin.py 가 생성) 을 읽는다."""
    import json
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "task_origin.json")
    if not os.path.exists(cfg_path):
        return np.array([-450.0, 0.0, 0.0]), False, "미측정 (task_origin.json 없음)"
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    return (np.array(cfg["origin_mm"], dtype=float),
            bool(cfg.get("measured", False)),
            f"{cfg.get('method')} / {cfg.get('saved_at')}")


TASK_ORIGIN_MM, TASK_ORIGIN_MEASURED, TASK_ORIGIN_SRC = _load_task_origin()


def _casing_center_m():
    """탄피 중심의 로봇 base 좌표(m). 국소 z 는 task_origin.json 이 들고 있다."""
    import json
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "task_origin.json")
    z = 0.1
    if os.path.exists(cfg_path):
        z = float(json.load(open(cfg_path, encoding="utf-8"))
                  .get("local_frame", {}).get("casing_center_z_m", 0.1))
    return TASK_ORIGIN_MM / 1000.0 + np.array([0.0, 0.0, z])

# ⚠ `APPROACH_RPY_DEG = (-179.224, 1.509, 91.191)` 를 여기 두었었다. **아무도 안 썼다.**
#   접근 자세는 `ToolIK.tool_quat(spin)` 이 정한다 — 툴 z축 연직 하향 + 축 회전이고,
#   접근에는 `spin=0` 이 들어간다. 그래서 저 상수는 계산에 한 번도 안 들어갔는데
#   "교육자료 14장 2-4절의 실측 예시" 라는 주석이 붙어 있어 **권위 있어 보였다.**
#   2026-09-07 에 티칭 자세의 실제 rz(+179.50°)와 대조하다 드러났다 — 88° 가 어긋나
#   문제인 줄 알았으나, 비교 대상 자체가 죽은 값이었다. 지운다 (2026-09-07).

HOVER_MM = 150.0        # [추정] 목표 위 호버 높이. 교육자료 14장의 안전 설계값 150mm
# 파지력 %. 실물 시험에서 30 으로 체결이 정상 완료됐다(2026-09-01).
#
# 더 올리지 않는다. 파지력은 사실상 토크 리미터로 동작하기 때문이다.
#   · 낮으면: 나사가 끝까지 조여져 토크가 오를 때 탄두가 그리퍼 안에서 미끄러진다.
#             나사산 대신 그리퍼가 지므로 부품이 보호된다.
#   · 높으면: 미끄러지지 않아 로봇 토크가 그대로 나사산에 걸린다. 나사산이 진다.
#             더해서 황동·구리는 무르고 탄두는 곡면이라 선 접촉이므로 눌림 자국이 남는다.
#
# 30 으로 체결됐다는 것은 필요 토크가 그 미끄럼 한계보다 작다는 뜻이다.
#   미끄럼 한계 T = 2 × μ × F × r = 2 × 0.2 × 30N × 4.5mm ≈ 0.054 N·m
#   -> 이 작업의 필요 토크는 약 0.05 N·m 이하 (M5 표준 체결토크 5~6 N·m 의 1/100)
GRIP_FORCE = 30         # [실측] 이 값으로 체결 성공 확인 (2026-09-01)

# 그리퍼 위치 (MoveGripper 2번째 인자, 0 = 닫힘 / 100 = 열림)
#   GRIP_POS  실물 시험에서 탄두를 물던 값. 완전히 닫으면(0) 손가락이 맞닿아
#             탄두 Ø9 를 짓누르거나 놓친다.
#   OPEN_POS  재파지 때 탄두가 빠질 만큼만 벌린다. 100(완전 개방)은 불필요하게
#             왕복이 길어져 재파지 9~10회 전체 시간이 늘어난다.
GRIP_POS = 17           # [실측] 실물에서 탄두 최대 외경(Ø9)을 물던 값.
                        #   도면 환산으로는 조 간격 7.60mm 라 Ø9 보다 1.40mm 좁다.
                        #   검정 고무 핑거가 편측 0.70mm 눌린 상태로 무는 것이며,
                        #   그 눌림이 파지력 30 으로도 미끄러지지 않는 이유다.
                        #   시뮬레이션(강체)은 9.0mm 로 그린다 — record_screw_video.FINGER_GRIP
OPEN_POS = 35           # [추정] 탄두 Ø9 가 빠질 만큼. 실물 확인 필요
APPROACH_TOL_MM = 3.0   # [추정] 접근 구간 도착 허용오차
INSERT_TOL_MM = 1.0     # [추정] 삽입 구간 도착 허용오차. 나사산 물림 편심(1.0mm)에 맞춤


# ══════════════════════════════════════════════════════════════════════════
# MuJoCo IK — MoveL 을 못 쓰므로 직교 목표를 관절각으로 바꾼다
# ══════════════════════════════════════════════════════════════════════════
class ToolIK:
    """단일 FR5 모델로 위치+자세 6자유도 IK 를 푼다 (녹화 스크립트와 같은 방식)."""

    ARM_JOINTS = ("j1", "j2", "j3", "j4", "j5", "j6")
    HOME_QPOS = np.array([0.0, -1.0, 1.2, -1.7, -1.57, 0.0])
    ORI_W = 0.10

    def __init__(self, mjcf=MJCF):
        self.model = mujoco.MjModel.from_xml_path(mjcf)
        self.data = mujoco.MjData(self.model)
        self.site = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SITE, "tool0")
        jids = [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, j)
                for j in self.ARM_JOINTS]
        self.dofs = np.array([self.model.jnt_dofadr[j] for j in jids])
        self.qadr = np.array([self.model.jnt_qposadr[j] for j in jids])
        self.lo = self.model.jnt_range[jids, 0]
        self.hi = self.model.jnt_range[jids, 1]
        self.data.qpos[self.qadr] = self.HOME_QPOS
        mujoco.mj_forward(self.model, self.data)

    @staticmethod
    def tool_quat(spin_rad):
        """툴 z축 연직 하향 + 축 회전(spin)."""
        c, s = np.cos(spin_rad), np.sin(spin_rad)
        R = np.diag([1.0, -1.0, -1.0]) @ np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
        q = np.zeros(4)
        mujoco.mju_mat2Quat(q, R.flatten())
        return q

    def solve(self, target_pos_m, spin_rad, max_iters=200, tol=1e-4):
        """목표 TCP 위치(m, 로봇 base 기준)와 축 회전각으로 관절각(deg) 반환."""
        q_des = self.tool_quat(spin_rad)
        jacp, jacr = np.zeros((3, self.model.nv)), np.zeros((3, self.model.nv))
        qc, qi, qe, w = np.zeros(4), np.zeros(4), np.zeros(4), np.zeros(3)
        for _ in range(max_iters):
            mujoco.mj_forward(self.model, self.data)
            ep = np.asarray(target_pos_m) - self.data.site_xpos[self.site]
            mujoco.mju_mat2Quat(qc, self.data.site_xmat[self.site])
            mujoco.mju_negQuat(qi, qc)
            mujoco.mju_mulQuat(qe, q_des, qi)
            mujoco.mju_quat2Vel(w, qe, 1.0)
            err = np.concatenate([ep, w * self.ORI_W])
            if np.linalg.norm(err) < tol:
                break
            mujoco.mj_jacSite(self.model, self.data, jacp, jacr, self.site)
            jac = np.vstack([jacp[:, self.dofs], jacr[:, self.dofs] * self.ORI_W])
            dq = jac.T @ np.linalg.solve(jac @ jac.T + 1e-3 * np.eye(6), err)
            self.data.qpos[self.qadr] = np.clip(self.data.qpos[self.qadr] + dq * 0.5,
                                                self.lo, self.hi)
        pos_err_mm = float(np.linalg.norm(
            np.asarray(target_pos_m) - self.data.site_xpos[self.site]) * 1000.0)
        return np.degrees(self.data.qpos[self.qadr].copy()), pos_err_mm

    def fk(self, joints_deg):
        """관절각(deg) -> TCP 위치(m). 관절각을 직접 지정했을 때 도착 판정용."""
        saved = self.data.qpos[self.qadr].copy()
        self.data.qpos[self.qadr] = np.radians(joints_deg)
        mujoco.mj_forward(self.model, self.data)
        pos = self.data.site_xpos[self.site].copy()
        self.data.qpos[self.qadr] = saved
        mujoco.mj_forward(self.model, self.data)
        return pos

    def with_wrist(self, joints_deg, wrist_rad):
        """
        같은 팔 자세에서 j6 만 지정 각도로 바꾼 관절 목표를 만든다.

        체결 회전은 IK 로 지정할 수 없다. 툴 자세는 축 회전에 대해 2π 주기라
        '-350° 되감기'를 요청해도 IK 가 같은 자세를 그대로 돌려주기 때문이다
        (실측: 재파지 목표 관절각이 스트로크 끝과 완전히 동일하게 나옴).
        회전량 자체가 목적이므로 j6 를 직접 지정한다.
        """
        j = np.asarray(joints_deg, dtype=float).copy()
        j[5] = float(np.degrees(wrist_rad))
        return j


# ══════════════════════════════════════════════════════════════════════════
# 시뮬 롤아웃 -> 웨이포인트
# ══════════════════════════════════════════════════════════════════════════
def rollout(policy_path, seed=0):
    """정책을 시뮬에서 굴려 궤적과 재파지 시점을 뽑는다."""
    from stable_baselines3 import PPO
    model = PPO.load(policy_path, device="cpu")
    env = E.FR5ScrewAssemblyEnv()
    obs, _ = env.reset(seed=seed)
    approach, strokes = [], []
    stroke_start = None
    prev_regrips = 0
    for _ in range(E.MAX_STEPS):
        a, _ = model.predict(obs, deterministic=True)
        obs, _, te, tr, info = env.step(a)
        if not env.engaged:
            approach.append(env.robot_ee_pos.copy())
        else:
            if stroke_start is None:
                stroke_start = env.wrist
            if info["regrips"] > prev_regrips:      # 스트로크 종료 = 재파지
                strokes.append((stroke_start, E.WRIST_LIMIT, env.depth))
                stroke_start = -E.WRIST_LIMIT
                prev_regrips = info["regrips"]
        if te or tr:
            if env.engaged and stroke_start is not None:
                strokes.append((stroke_start, env.wrist, env.depth))
            return approach, strokes, info
    return approach, strokes, info


def compress(points, min_step_mm=8.0):
    """궤적을 웨이포인트로 압축 (일정 거리 이상 움직였을 때만 남긴다)."""
    out = []
    for p in points:
        if not out or np.linalg.norm(p - out[-1]) * 1000.0 >= min_step_mm:
            out.append(np.asarray(p, dtype=float))
    if points and (not out or not np.allclose(out[-1], points[-1])):
        out.append(np.asarray(points[-1], dtype=float))
    return out


def to_robot_m(local_m):
    """학습 국소좌표(m) -> 로봇 base 좌표(m)."""
    return np.asarray(local_m, dtype=float) + TASK_ORIGIN_MM / 1000.0


def preflight_gates(dry):
    """**선행 조건.** 안 닫히면 실물 실행을 거부한다 — 경고가 아니라 거부다.

    `fr5_assemble_sdk.preflight_gates()` 와 같은 세 가지를 본다. 전에는 이 파일이
    작업 원점만 보고 나머지 둘을 **아예 참조하지 않아서**, 문서가 안내하는
    `summarize_run.py` → `fr5_execute_policy.py --grasp` 경로로 가면 미검증 상태로
    조이는 방향 동작이 나갔다 (2026-09-08 발견). 두 문을 같게 만든다.

    ⚠ `fr5_assemble_sdk` 를 import 해서 재사용하지 않는다 — 그쪽이 이 모듈을
      import 하므로 순환이 된다. 목록을 따로 두되 내용은 같게 유지한다.
    """
    gates = [
        ("작업 원점 실측", TASK_ORIGIN_MEASURED,
         f"현재 {TASK_ORIGIN_MM.tolist()}mm ({TASK_ORIGIN_SRC}) — "
         "python3 fr5_calibrate_task_origin.py --from-joints"),
        ("툴축 부호 확인", SITE.ZSIGN_VERIFIED,
         "screw_stroke_cycle.py --strokes 1 --substeps 1 --zlift --vel 3 --run 로 "
         "한 칸(0.326mm)만 움직여 눈으로 보고 fr5_site.ZSIGN_VERIFIED 를 True 로"),
        ("충돌 감지 정지 확인", SITE.COLLISION_STOP_VERIFIED,
         "python3 verify_collision_stop.py --run — 오탐 없음(확인됨)과 "
         "진짜 멈춤(미확인)은 다르다. 조이는 방향의 유일한 방어선이다"),
    ]
    print("\n[0] 선행 조건")
    bad = []
    for name, ok, how in gates:
        print(f"    {'✅' if ok else '⛔'} {name}")
        if not ok:
            bad.append(f"    · {name} — {how}")
    if bad and not dry:
        raise SystemExit("\n⛔ 선행 조건이 안 닫혔다. 실물 실행을 거부한다:\n"
                         + "\n".join(bad)
                         + "\n\n  조립은 **조이는 방향**이라 실패가 과조임이고 되돌릴 수 없다.")
    if bad:
        print("    (dry-run 이라 계속한다 — 실물 실행은 거부된다)")
    return not bad


# ══════════════════════════════════════════════════════════════════════════
def main():
    do_move = "--move" in sys.argv
    do_grasp = "--grasp" in sys.argv
    dry = not (do_move or do_grasp)

    print("═" * 74)
    print("FR5 나사 체결 정책 실물 실행", "(dry-run)" if dry else
          ("(실물: 호버까지만)" if do_move and not do_grasp else "(실물: 전체 수행)"))
    print("═" * 74)

    if not TASK_ORIGIN_MEASURED:
        print(f"\n⚠️  작업 원점이 실측값이 아닙니다 — {TASK_ORIGIN_SRC}")
        print(f"    현재 값 {TASK_ORIGIN_MM.tolist()} mm")
        print("    측정:  python3 fr5_calibrate_task_origin.py --from-robot --tool bullet")
        if not dry:
            raise SystemExit("중단: 작업 원점 미실측 상태에서는 실물 실행을 거부합니다.")

    else:
        print(f"\n📐 작업 원점 {TASK_ORIGIN_MM.tolist()} mm  ({TASK_ORIGIN_SRC})")

    preflight_gates(dry)

    policy, score = pick_policy()
    print(f"\n[1] 정책 선정: {os.path.relpath(policy, POLICY_DIR)} "
          f"(성공률 {score[0]*100:.0f}%, 문지름 {-score[1]:.1f}스텝)")

    # 실패한 롤아웃을 실물로 보내면 안 된다. 성공하는 시드를 찾을 때까지 재시도한다.
    for seed in range(20):
        approach, strokes, info = rollout(policy, seed=seed)
        if info["is_success"]:
            break
    print(f"    롤아웃(seed={seed}): 접근 스텝 {len(approach)} / 체결 스트로크 {len(strokes)} "
          f"/ 체결깊이 {info['depth_mm']:.2f}mm / 성공 {info['is_success']}")
    if not info["is_success"]:
        raise SystemExit("중단: 20개 시드 모두 체결에 실패했습니다. 정책을 다시 학습하세요.")

    waypoints = compress(approach)
    print(f"[2] 접근 궤적 압축: {len(approach)} 스텝 -> 웨이포인트 {len(waypoints)}개")

    print("[3] IK 로 관절각 계산 (MoveL 이 금지 명령이라 MoveJ 로 보낸다)")
    ik = ToolIK()
    plan = []
    hover_local = np.array([waypoints[0][0], waypoints[0][1],
                            E.MOUTH_Z + E.TCP_TO_TIP + HOVER_MM / 1000.0])
    for tag, local, spin in (
            [("hover", hover_local, 0.0)]
            + [(f"approach{i}", w, 0.0) for i, w in enumerate(waypoints)]):
        p = to_robot_m(local)
        j, err = ik.solve(p, spin)
        plan.append((tag, j, p * 1000.0, err))
    worst = max(e for _, _, _, e in plan)
    print(f"    IK 잔차 최대 {worst:.3f}mm")
    if worst > 1.0:
        print("    ⚠️ IK 잔차가 큽니다. 도달 불가 지점이 섞였을 수 있습니다.")

    # ── [3-b] 자기충돌 검사 — **보내기 전에** (2026-09-03 신설) ──────────────
    #
    # 2026-09-02 실기 사고: WebApp 저장점으로 PTP 이동시켰더니 **그리퍼가 자기 몸체를
    # 쳤다.** PTP 는 관절을 보간할 뿐 손끝 궤적을 계획하지 않는다 — 두 점 사이에 몸체가
    # 있으면 그냥 통과하려 든다. 그런데 이 스택 어디에도 자기 몸을 보는 코드가 없었다
    # (`check_joint_limits` 는 **관절 한계만** 본다 — 모든 관절이 범위 안이면서 팔이
    #  자기 몸을 관통하는 자세는 얼마든지 있다).
    #
    # ⚠ **끝점만 보면 못 잡는다.** 시작도 목표도 멀쩡한데 가는 길 한가운데서 친다.
    #   그래서 ①웨이포인트마다 자세를 보고 ②첫 이동은 **가는 길까지** 훑는다.
    # 브리지를 여기서 만든다 — `current_joints_deg()` 는 토픽을 **읽기만** 하므로
    # `startup()`(서보 ON) 전에 불러도 안전하다. 검사가 먼저고 활성화가 나중이다.
    bridge = FR5Bridge(dry_run=dry)

    print("\n[3-b] 자기충돌 검사 (MuJoCo 씬 · 보내기 전)")
    bad_static = []
    for tag, j, _, _ in plan:
        hits = selfcheck.self_collision(j)
        for a, b, dist in hits:
            bad_static.append(f"{tag}: {a} ↔ {b} {abs(dist):.1f}mm 관통")
    print(f"    웨이포인트 {len(plan)}개 자세 — 관통 {len(bad_static)}건")

    # ── 책상 이격 — 그리퍼가 책상 위 DESK_CLEAR_MM 아래로 못 내려간다 ──────────
    # 관통 검사와 다른 이야기다. 관통은 "닿았나", 이건 "닿기 전 여유가 있나" 다.
    # 체결 자세까지 **전부** 미리 풀어서 본다 — 보내고 나서 알면 늦다.
    limit_z = (selfcheck.desk_top_m() * 1000.0) + DESK_CLEAR_MM
    poses = [(tag, j) for tag, j, _, _ in plan]
    insert_local0 = np.array([0.0, 0.0, E.MOUTH_Z + E.TCP_TO_TIP])
    for n, (w0, w1, depth) in enumerate(strokes, 1):
        j_base, _ = ik.solve(to_robot_m(insert_local0 - np.array([0, 0, depth])), w0)
        poses.append((f"스트로크{n}", ik.with_wrist(j_base, w1)))
    ok_desk, bad_desk = selfcheck.scan_desk_clearance(poses, limit_z)
    case_mm = _casing_center_m() * 1000.0
    ok_box, bad_box = selfcheck.scan_j6_box(
        poses, case_mm[:2], selfcheck.desk_top_m() * 1000.0,
        J6_BOX_HALF_XY_MM, J6_BOX_Z_MIN_MM, J6_BOX_Z_MAX_MM)
    j6s = np.array([selfcheck.j6_pos_mm(j) for _, j in poses])
    print(f"    j6 허용 상자 — 탄피 ±{J6_BOX_HALF_XY_MM:.0f}mm / 책상 위 "
          f"{J6_BOX_Z_MIN_MM:.0f}~{J6_BOX_Z_MAX_MM:.0f}mm / 실제 수평 "
          f"({(j6s[:,0]-case_mm[0]).min():+.1f}~{(j6s[:,0]-case_mm[0]).max():+.1f}, "
          f"{(j6s[:,1]-case_mm[1]).min():+.1f}~{(j6s[:,1]-case_mm[1]).max():+.1f})mm "
          f"높이 {(j6s[:,2]-selfcheck.desk_top_m()*1000).min():.0f}~"
          f"{(j6s[:,2]-selfcheck.desk_top_m()*1000).max():.0f}mm "
          f"— {'통과' if ok_box else f'위반 {len(bad_box)}건'}")
    bad_desk += bad_box
    lowest = min(selfcheck.gripper_min_z_mm(j)[0] for _, j in poses)
    print(f"    책상 이격 — 상면 {selfcheck.desk_top_m()*1000:.1f}mm + {DESK_CLEAR_MM:.0f}mm "
          f"= 금지선 {limit_z:.1f}mm / 자세 {len(poses)}개 최저 {lowest:.1f}mm "
          f"— {'통과' if ok_desk else f'위반 {len(bad_desk)}건'}")

    # 첫 이동(현재 자세 → hover)이 제일 길고, 사고가 난 것도 이 모양이다.
    bad_path = []
    if dry:
        print("    ⚠️ dry-run 이라 현재 자세를 못 읽는다 — **첫 이동 경로는 검사하지 못했다.**")
        print("       실물에서는 현재 자세를 읽어 hover 까지의 경로를 훑는다.")
        print("       시작 j6 상자·경로 책상이격 검사도 실물에서만 한다.")
    else:
        j_now = bridge.current_joints_deg()
        print(f"    현재 자세 {[round(v,1) for v in j_now]}")
        ok, why = selfcheck.scan_joint_path(j_now, plan[0][1], n=PATH_SCAN_SAMPLES)
        bad_path = why
        print(f"    첫 이동 경로 {PATH_SCAN_SAMPLES}점 훑기 — "
              f"{'통과' if ok else f'위반 {len(why)}건'}")

        # ── 거리 제한 — 탄피 위로 움직이기 전에 **탄피에서 얼마나 떨어져 있나** ──
        # 관통이 없어도 멀면 거부한다. MoveJ 는 관절 보간이라 멀리서 출발하면 팔이
        # 크게 휘돌고, 씬에 없는 물건은 아무도 안 본다.
        # 가는 길에서도 책상 이격을 본다 — 끝점만 보면 중간에서 훑고 지나간다
        a_, b_ = np.asarray(j_now, float), np.asarray(plan[0][1], float)
        path_poses = [(f"경로 {100*i/PATH_SCAN_SAMPLES:.0f}%", a_ + (b_ - a_) * (i / PATH_SCAN_SAMPLES))
                      for i in range(PATH_SCAN_SAMPLES + 1)]
        ok_pd, bad_pd = selfcheck.scan_desk_clearance(path_poses, limit_z)
        ok_pb, bad_pb = selfcheck.scan_j6_box(
            path_poses, case_mm[:2], selfcheck.desk_top_m() * 1000.0,
            J6_BOX_HALF_XY_MM, J6_BOX_Z_MIN_MM, J6_BOX_Z_MAX_MM)
        print(f"    첫 이동 경로 — 책상이격 {'통과' if ok_pd else f'위반 {len(bad_pd)}건'} / "
              f"j6 상자 {'통과' if ok_pb else f'위반 {len(bad_pb)}건'}")
        bad_desk += bad_pd + bad_pb

        # ── 시작 자세 — 탄피 위로 움직이기 전에 j6 이 상자 안에 있어야 한다 ──
        x, y, z = selfcheck.j6_pos_mm(j_now)
        dt = selfcheck.desk_top_m() * 1000.0
        print(f"    시작 j6 위치 — 탄피대비 ({x-case_mm[0]:+.1f}, {y-case_mm[1]:+.1f})mm / "
              f"책상 위 {z-dt:.1f}mm")
        ok_s, why_s = selfcheck.scan_j6_box(
            [("시작 자세", j_now)], case_mm[:2], dt,
            J6_BOX_HALF_XY_MM, J6_BOX_Z_MIN_MM, J6_BOX_Z_MAX_MM)
        if not ok_s:
            raise SystemExit(
                "중단: 시작 자세의 j6 이 허용 상자를 벗어났습니다.\n      "
                + "\n      ".join(why_s)
                + "\n      python3 go_home.py 로 실측 자세로 되돌린 뒤 다시 실행하세요.")

    if bad_static or bad_path or bad_desk:
        for line in (bad_static + bad_path + bad_desk)[:12]:
            print(f"      ⛔ {line}")
        raise SystemExit(
            "중단: 충돌 또는 책상 이격 위반이 예측됩니다. 시작 자세를 탄피 근처로 옮기고\n"
            "      다시 시도하거나, 경로를 나눠 중간 경유점을 넣으세요.\n"
            "      (자기충돌은 2026-09-02 사고와 같은 계열, 책상 이격은 DESK_CLEAR_MM)")
    print("    ✅ 자기충돌 없음")

    # 사전 검사를 통과했어도 **가는 도중**을 본다 — 서보 지연·미끄러짐·사람이 건드린 경우.
    # 20Hz 폴링에서 그리퍼가 금지선에 닿으면 서보를 끄고 멈춘다 (FR5Bridge._assert_floor).
    bridge.set_floor_guard(limit_z)
    print(f"\n[3-c] 바닥 가드 작동 — 이동 중 그리퍼가 z={limit_z:.1f}mm 에 닿으면 정지")

    print("\n[4] 실행 시퀀스")
    try:
        bridge.startup(speed_percent=5)
        bridge.gripper_init()
        bridge.gripper(GRIP_POS, force=GRIP_FORCE)   # 탄두 파지 (이미 물려 있다고 가정)

        for tag, j, xyz_mm, _ in plan:
            tol = APPROACH_TOL_MM if tag.startswith(("hover", "approach")) else INSERT_TOL_MM
            print(f"   [{tag}]")
            bridge.move_joints(j, xyz_mm, vel=5, tol_mm=tol)
            if tag == "hover" and do_move and not do_grasp:
                print("   --move: 호버 위치까지만 수행하고 종료합니다.")
                return

        if dry or do_grasp:
            insert_local = np.array([0.0, 0.0, E.MOUTH_Z + E.TCP_TO_TIP])
            total_rev = abs(strokes[-1][1]) / (2 * np.pi) if strokes else 0.0

            # j6 방식: 한 스트로크가 0.956바퀴(344°)뿐이라 재파지가 필요하다.
            print(f"\n[5] 나사 체결 (j6) — 스트로크 {len(strokes)}회, 스트로크마다 재파지")
            for n, (w0, w1, depth) in enumerate(strokes, 1):
                p_m = to_robot_m(insert_local - np.array([0, 0, depth]))
                j_base, _ = ik.solve(p_m, w0)
                j_end = ik.with_wrist(j_base, w1)
                print(f"   [스트로크 {n}] j6 {np.degrees(w0):+.0f}° -> "
                      f"{np.degrees(w1):+.0f}° / 체결깊이 {depth*1000:.2f}mm")
                bridge.move_joints(j_end, ik.fk(j_end) * 1000.0, vel=5,
                                   tol_mm=INSERT_TOL_MM, point_id=2)
                if n < len(strokes):
                    bridge.gripper(OPEN_POS)
                    j_back = ik.with_wrist(j_end, -E.WRIST_LIMIT)
                    print(f"      ↺ 재파지: j6 -> {np.degrees(-E.WRIST_LIMIT):+.0f}°")
                    bridge.move_joints(j_back, ik.fk(j_back) * 1000.0, vel=5,
                                       tol_mm=INSERT_TOL_MM, point_id=3)
                    bridge.gripper(GRIP_POS, force=GRIP_FORCE)

            print("\n[6] 마무리 — 그리퍼 열고 후퇴")
            bridge.gripper(OPEN_POS)   # 완성품 놓기
            bridge.move_joints(plan[0][1], plan[0][2], vel=5, tol_mm=APPROACH_TOL_MM)
    except (FR5CommandError, FR5SafetyError) as e:
        print(f"\n🛑 중단: {e}")
        raise
    finally:
        bridge.shutdown()

    print(f"\n전송된 명령 {len(bridge.sent)}개")
    print("✅ 모든 이동·그리퍼 명령이 완료 확인 후 다음 단계로 진행했습니다.")


if __name__ == "__main__":
    main()
