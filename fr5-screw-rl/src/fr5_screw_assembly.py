#
# 🔩 FR5 탄두-탄피 나사 체결 강화학습 환경 (실측 치수 기반 재설계판)
#
# ─ 기존 fr5_multi_fleet_control.FR5ScrewAssemblyEnv 의 문제 ────────────────
#   · TCP 를 크기 없는 '점'으로 보고, 성공 판정이 dist < 3.2cm 였다.
#     실측 탄피 지름이 1.0cm 이므로 허용오차가 부품 지름의 3배 -> '체결'이 아니라
#     '근처 도달'을 학습했다. 렌더링하면 탄두가 탄피를 관통해 빠져나간다.
#   · 그리퍼가 쥔 탄두 길이(TCP~나사 선단 13mm)가 전혀 반영돼 있지 않았다.
#   · 나사 체결인데 축 회전이 태스크에 없었다. (탄두 하단은 수나사, 탄피 목은 암나사)
#
# ─ 이 파일에서 바꾼 것 ────────────────────────────────────────────────────
#   1. 실측 치수(IMG_4636/4637/4643/4644)를 그대로 상수화
#   2. 삽입을 '입구 통과 -> 나사 물림 -> 회전 체결' 3단계 물리로 모델링
#      - 정렬이 안 된 채 내리면 입구에 걸려 더 못 내려간다(jam)
#      - 물린 뒤 축방향 전진은 오직 회전으로만 발생한다 (depth += 회전량/2π × 피치)
#   3. 성공 판정 = **어깨가 앉을 때**(나사부 6mm 전체 체결). 편심 3.2cm 가 아니다
#   4. 손목 관절 한계(j6 ±3.0543rad)로 한 번에 1바퀴도 못 돌린다는 실제 제약을
#      재파지(re-grip) 이벤트로 반영하고 비용을 물린다
#
import numpy as np
import gymnasium as gym
from gymnasium import spaces

# ── 실측 치수 (m) ─────────────────────────────────────────────────────────
CASE_LEN      = 0.057    # 탄피 전장            (IMG_4636: 5.7cm)
CASE_OD       = 0.010    # 탄피 결합부 외경      (IMG_4644: 1.0cm)
CASE_ID       = 0.005    # 탄피 결합부 내경      (IMG_4644: 0.5cm)
THREAD_DEPTH  = 0.006    # [실측 2026-09-07 정정] 탄두 **수나사부의 길이** = 6mm
#   ⚠ 2026-09-07 이전 값 0.007 은 틀렸다. 자로 다시 재서 0.006 으로 정정했다.
#     이 값이 어깨 착좌 깊이이자 탄피 보어 깊이라 메시(make_ammo_meshes)도 같이 따라간다.
# ⚠ 이 값은 **나사부 길이**이자, 탄두 어깨(Ø9)가 탄피 입구에 앉는 깊이다.
#   탄두 몸통이 나사부(Ø5)보다 굵어서 나사가 끝나는 자리에서 어깨가 걸려 멈춘다.
#   탄피 보어 깊이도 같은 값이라 메시(make_ammo_meshes)가 이걸 그대로 쓴다.

# ⚠ **0점이 둘이라 헷갈리기 쉽다.**
#   시뮬의 `depth` : **탄두 선단이 탄피 입구면에 닿은 곳**에서 잰다
#                    (robot_ee_pos[2] = MOUTH_Z - depth + TCP_TO_TIP)
#   실기에서 재는 값 : **탄두를 입구에 얹은 상태**가 기준이다
#   얹으면 모따기와 첫 나사산을 타고 저절로 내려앉으므로 그만큼은 회전 없이 들어간다.
PLACED_DEPTH  = 0.001    # [실측 2026-09-07] 얹으면 저절로 들어가는 깊이.
#   근거: 얹은 상태에서 입구 위로 남은 나사부가 5.0mm 였다 → 6.0 - 5.0 = 1.0

# 얹은 자리에서 **어깨가 앉을 때까지** 회전으로 넣어야 하는 양 — 기하로 정해진다.
#   자로 잰 값 둘(나사부 6.0, 얹었을 때 노출 5.0)만으로 나오므로 단단하다.
SCREW_TRAVEL  = THREAD_DEPTH - PLACED_DEPTH     # = 5.00mm
#
# ⚠ 2026-09-08 이전에는 여기가 **0.00350** 이었다. 09-07 에 실제로 돌린 회전량
#   (1578.5° = 4.385바퀴 x 0.8mm = 3.51mm)을 요구량으로 삼았던 것인데, "그날 착좌했다"가
#   전제였다. 09-08 에 4 스트로크를 돌린 뒤 그리퍼를 열자 **탄두가 빠지면서** 그 전제가
#   무너졌다 — 물린 적이 없었다. 회전량 환산값을 버리고 기하로 돌아왔다.
#   ⚠ 그리고 회전량 환산은 **그리퍼 무슬립·피치 0.8·회전=전진** 세 가정에 기댄다.
#     기하값은 그 가정이 필요 없다.
SCREW_TRAVEL_COMMANDED_20260907 = 0.00351   # [계산·참고] 그날 명령한 회전량 환산

# 시뮬이 "다 잠겼다" 로 볼 깊이 = **어깨가 탄피 입구에 앉는 지점**.
SEAT_DEPTH    = PLACED_DEPTH + SCREW_TRAVEL   # = THREAD_DEPTH = 6.00mm
# 기하와 일치하므로 메시(어깨 6.0)와 어긋나지 않는다 — 렌더링해도 틈이 안 보인다.

BULLET_LEN    = 0.030    # 탄두 전장 (노출 2.4 + 나사 0.6) — 전장은 그대로, 나사부만 정정
BULLET_OD     = 0.009    # 탄두 하단 최대 외경   (IMG_4643: 0.9cm)
THREAD_OD     = 0.005    # 탄두 나사부 외경      (IMG_4643: 0.5cm)
THREAD_PITCH  = 0.0008   # M5 표준 피치 (내경·외경 모두 Ø5 -> M5 로 판단)
TCP_TO_TIP    = 0.009    # [실측 파지위치 2026-09-07] tool0(조 끝) ~ 탄두 나사 선단
#   조 아랫면이 **나사산 시작(어깨, 선단에서 6mm)보다 3mm 위**를 잡는다 → 6 + 3 = 9mm.
# ⚠ 이전 값 0.013 은 IMG_4917 과 안 맞았다 — 그 사진(탄두를 탄피에 얹고 티칭하던 순간)에서
#   **조 아랫면이 탄피 입구 높이**이고 나사산이 이미 물려 있다. 13mm 라면 선단이 입구보다
#   13mm 아래여야 하는데 그러면 씬 전체가 19.4mm 어긋난다. 6mm 로 보면 4.4mm 로 줄고,
#   나사부(6mm)가 딱 물린 상태가 되어 사진과 맞는다.
#   **아직 자로 안 잰 값이다.** 탄두를 17% 로 물고 조 아랫면 ~ 나사 선단을 재면 확정된다.
#   ⚠ task_origin.json 은 아직 13mm 가정으로 저장돼 있다. 실물에 쓰기 전에 같이 맞춰라.

CASE_CENTER_Z = 0.10                      # 작업 국소좌표계에서의 탄피 중심 높이
MOUTH_Z       = CASE_CENTER_Z + CASE_LEN / 2   # 결합면(입구) 높이 = 0.1285
PRE_Z         = MOUTH_Z + TCP_TO_TIP + 0.002   # 삽입 직전 TCP 목표 높이(선단이 입구 2mm 위)
START_Z       = 0.180                     # 에피소드 시작 TCP 높이

# ── 물림 허용오차 ─────────────────────────────────────────────────────────
# ENTRY_TOL 은 MuJoCo 자유낙하 시험(_ammo_fit_preview.xml)에서 확인한 값.
# 탄두 Ø9 어깨가 탄피 Ø10 입구에 걸쳐 미끄러지는 self-centering 한계가 2.5mm 였다.
ENTRY_TOL     = 0.0025            # 입구 통과 편심 한계
THREAD_TOL    = 0.0010            # 나사산이 깨끗하게 물리는 편심 (이 밖이면 crossthread 위험)
TILT_TOL      = np.deg2rad(3.0)   # 축 기울기 한계

# ── 실제 로봇 제약 ────────────────────────────────────────────────────────
# [기하] SCREW_TRAVEL 5.00mm / 피치 0.8mm = **6.25 바퀴**가 필요하다.
# j6 하드 한계는 ±175° 지만 실기 운용은 여유 3° 를 두고 **±172°** 만 쓴다
# (fr5_site.J6_MARGIN_DEG). 한 스트로크 = -172 → +172 = **344° = 0.956 바퀴 = 0.764mm**.
# 따라서 착좌까지 5.00/0.764 = **6.54 스트로크**. 실기는 6회 돌리고 눈으로 확인한다.
#
# ⚠ **2026-09-08 이전 값(4.375 바퀴 / 4.58 스트로크)을 쓰지 마라.** 그것은
#   SCREW_TRAVEL 이 3.50mm 이던 시절의 값이고, 그 3.50 은 "그날 착좌했다"를 전제한
#   회전량 환산이었다. 09-08 에 4 스트로크를 돌린 뒤 그리퍼를 열자 탄두가 빠지면서
#   전제가 무너졌다 (위 SCREW_TRAVEL 주석 참조). 기하값 5.00mm 가 현재 값이다.
WRIST_LIMIT   = np.deg2rad(172.0)   # [실측] 3.0019 rad — fr5_site 와 같은 여유각
REGRIP_COST   = 3.0


# ── 시간 기준 ─────────────────────────────────────────────────────────────
# ⚠️ 이전에는 이 환경에 시간 개념이 없었다. 스텝이 몇 초인지 정의되지 않으니
#    속도 제한을 걸 방법도 없었고, 정책이 실물 로봇으로 낼 수 없는 속도를
#    명령해도 학습 중에는 아무 문제가 되지 않았다.
#    (렌더링만 늦춰 그럴듯하게 보이게 하는 것은 시뮬레이션 수정이 아니다)
#    한 스텝을 실제 제어 주기에 대응시키고, 행동 스케일을 관절 속도 한계에서
#    역산해 정책이 물리적으로 가능한 명령만 낼 수 있게 한다.
# ⚠ 아래 CONTROL_DT / SPIN_SCALE 은 **실기 실행 방식에서 역산한다** (2026-09-08).
#   전에는 CONTROL_DT = 0.1 [추정] 이었고 근거가 없었다. 그 값이면 시뮬이 j6 를
#   179.7°/s(전속)로 돌리는 셈인데, 실기는 안전상 --vel 10 (17.97°/s) 로 쓴다 — 10배 차이.
#
#   속도(°/s) = 한 스텝에 도는 각도(SPIN_SCALE) ÷ 한 스텝에 걸리는 시간(CONTROL_DT)
#
#   맞추는 길이 둘인데 결과가 다르다:
#     ㉠ 각도를 줄인다  1.8° / 0.1초  → 속도는 맞지만 정책이 실물보다 19배 자주 판단하고,
#                                      에피소드가 8배 길어져 스텝 벌점이 8배 쌓인다.
#                                      실제로 해보니 성공률 75% → 30% 로 떨어졌다.
#     ㉡ 시간을 늘린다  34.4° / 1.9초 → 속도도 맞고 판단 주기도 실물과 같다.  ← 이걸 쓴다
#
#   실기(fr5_screw_in.py)는 스트로크 344° 를 10칸으로 나눠 MoveJ 를 건다 = 한 번에 34.4°.
#   그것을 vel 10% 로 실행하면 1.91초. 그래서 아래처럼 잡는다.
SUBSTEPS      = 10       # 실기 fr5_screw_in.py --substeps 기본값

# 관절/TCP 최대 속도.
# ⚠️ 보유한 교육자료 6종에는 관절 속도 사양이 없다. 협동로봇 손목의 통상값을
#    적었으므로 FR5 공식 데이터시트로 반드시 확인할 것.
#    ⚠ J6_MAX_SPEED 는 CONTROL_DT 를 통해 실제로 영향을 준다.
#      반면 TCP_MAX_SPEED / TILT_MAX_RATE 는 지금 **행동 스케일에 영향이 없다**
#      (아래 POS_SCALE 주석 참조). 셋을 같은 무게로 읽지 마라.
J6_MAX_SPEED  = np.deg2rad(179.7)   # [실측 2026-09-05] rad/s — 이 기체에서 잰 값.
# ⚠ 실기 조립은 안전상 vel 3%(약 5.4°/s)로 돌린다. 여기 값은 **물리 한계**이고
#   운용 속도가 아니다. 정책이 이 한계까지 명령해도 실물에 그대로 내보내지 않는다.
TCP_MAX_SPEED = 0.25                # [추정] m/s — 직교 이송
TILT_MAX_RATE = np.deg2rad(20.0)    # [추정] rad/s — 자세 보정

# 운용 속도는 **분당 스트로크 수**로 정한다 — 사람이 그렇게 생각하고, 그게 작업 리듬이다.
#   스트로크 = -172° → +172° = 344° (j6 가동범위 ±175 에서 여유 3° 뺀 것)
OP_STROKE_PER_MIN = 4.0      # [운용] 15초에 1스트로크 = 분당 4
OP_SPEED_PCT  = (2.0 * np.degrees(WRIST_LIMIT) * OP_STROKE_PER_MIN / 60.0
                 / np.degrees(J6_MAX_SPEED) * 100.0)     # = 3.19%

# ── 행동 스케일 (스텝당) — **실기 실행 방식에서 역산** ────────────────────
# 한 스텝에 도는 각도 = 실기의 한 칸 = 스트로크 / 칸수
SPIN_SCALE    = 2.0 * WRIST_LIMIT / SUBSTEPS                       # rad (= 34.4°)
# 그 각도를 실기 운용 속도로 실행하는 데 걸리는 시간 = 한 스텝의 실제 길이
CONTROL_DT    = SPIN_SCALE / (J6_MAX_SPEED * (OP_SPEED_PCT / 100.0))   # 초

# ⚠ **아래 두 줄에서 실제로 값을 정하는 것은 앞의 상수(0.004 / 0.02)다.**
#   min() 의 뒤쪽(속도 x 시간)이 이기려면 TCP_MAX_SPEED 가 0.0027 m/s 아래여야 하는데
#   지금은 0.25 다 — 계산하면 0.375m 이라 한 번도 이긴 적이 없다. TILT 도 같다(30° vs 1.15°).
#   그래서 "TCP_MAX_SPEED 를 고치면 행동 스케일이 따라간다"는 말은 **사실이 아니다.**
#   속도 한계는 상한을 확인하는 용도로만 남기고, 실제 스케일은 아래 상수가 정한다.
#
#   ⚠ 그 상수의 근거: **[추정]이다.** 스텝당 이동량을 이 정도로 묶어두면 정책이
#     한 스텝에 부품을 건너뛰지 않는다는 판단에서 고른 값이고, 실기에서 잰 적은 없다.
#     한 스텝이 0.1초이던 시절에 정했고 지금은 1.5초라 **환산 속도가 그때의 1/15 이다.**
#     실기 접근 속도를 재면 이 두 줄을 그 값으로 바꿔야 한다.
#       POS_STEP_M   4.0mm / 1.5초 = 2.67 mm/s
#       TILT_STEP_RAD 1.15° / 1.5초 = 0.76 °/s
POS_STEP_M    = 0.004    # [추정] 스텝당 TCP 이동 상한 (m)
TILT_STEP_RAD = 0.02     # [추정] 스텝당 자세 보정 상한 (rad)
POS_SCALE     = min(POS_STEP_M,    TCP_MAX_SPEED * CONTROL_DT)   # m
TILT_SCALE    = min(TILT_STEP_RAD, TILT_MAX_RATE * CONTROL_DT)   # rad
if POS_SCALE != POS_STEP_M or TILT_SCALE != TILT_STEP_RAD:
    # 속도 한계 쪽이 이기는 상황이 되면 알린다 — 조용히 바뀌면 아무도 모른다.
    import warnings
    warnings.warn(f"행동 스케일이 속도 한계에 걸렸다: POS {POS_SCALE*1000:.2f}mm "
                  f"TILT {np.degrees(TILT_SCALE):.2f}° — 상수 대신 속도가 정하고 있다")

# 체결에 필요한 회전 6.25바퀴(39.3rad)를 SPIN_SCALE 로 나눈 값 + 접근·재파지 여유.
# 회전 속도를 실제 한계로 낮추면 필요한 스텝 수가 늘어나므로 자동으로 따라가게 한다.
# ⚠ 여유(배수·상수)는 **한 스텝이 0.1초이던 시절**에 정한 값이었다. 지금은 한 스텝이
#   실기 한 칸(1.9초)이라 재파지 한 번이 차지하는 비중이 훨씬 크다. 그래서 여유를 늘렸다.
#     회전만 65 스텝 · 재파지 7회 · 접근/정렬
MAX_STEPS     = int(SCREW_TRAVEL / THREAD_PITCH * 2 * np.pi / SPIN_SCALE * 2.0) + 120

# 정렬 안 된 채 내려가 결합면을 문지를 때의 페널티.
# 2.0 에서는 "일단 내려가서 비비며 맞춘다"는 정책이 학습돼 실물에서 나사산이 상한다.
#
# 고정 페널티만으로는 학습이 진행될수록 문지름이 오히려 늘어난다
# (실측: 25만 스텝 11회 -> 30만 스텝 63회). 짧게 스치는 비용과 계속 비비는 비용이
# 같아서, 정책이 "비비면서 축을 맞추는" 전략을 택하기 때문이다.
# 실물에서는 문지를수록 나사산·모서리 손상이 누적되므로, 에피소드 내 누적
# 문지름 횟수에 비례해 페널티가 커지도록 한다.
#   N 스텝 문지를 때 총비용 = JAM_PENALTY x (N + JAM_ESCALATION x N(N-1)/2)
#   -> 10회는 82점, 30회는 480점, 60회는 1773점으로 급격히 불리해진다
# 증가율을 0.6 까지 올려도 봤으나, 탐색 중 페널티가 너무 커져 결합면 접근
# 자체를 회피(전 구간 성공률 0%)했다. 0.3 이 학습이 되는 상한이다.
JAM_PENALTY    = 3.0
JAM_ESCALATION = 0.3

# ⚠️ '한계 초과 시 부품 폐기로 에피소드 종료' 도 시도했으나 실패했다.
#    폐기 페널티를 크게(200) 주면 결합면 접근 자체를 회피해 전 구간 성공률 0%,
#    작게 주면 에피소드를 일부러 끝내 남은 페널티를 피하는 편법이 생긴다.
#    그래서 종료 대신, 상한을 둔 누적 페널티만 쓴다. (JAM_LIMIT=0 이면 종료 없음)
JAM_LIMIT      = 0
SCRAP_PENALTY  = 200.0

# 스텝당 페널티 배수의 상한. 상한이 없으면 탐색 중 한 번 길게 문지른 것만으로
# 보상이 폭발해 학습이 불안정해진다.
JAM_PENALTY_CAP = 15.0

# ── 빗물림(cross-thread)과 스톨 착좌 판정 (2026-09-03) ──────────────────────
#
# **왜 넣나** — 상수 이름은 `THREAD_TOL ... 이 밖이면 crossthread 위험` 인데 코드는
# 그 위험을 구현한 적이 없었다. 편심 1.0~2.5mm 로 비뚤게 물려도 **감점 40점만 내고
# 끝까지 다 들어갔다.** 성공 보상이 2000점이라 대충 물리는 편이 이득일 수 있었다.
#
# **무엇이 달라지나** — 비뚤게 물리면 그만큼 얕은 깊이에서 막힌다(`depth_cap`).
# 그리고 막히면 **j6 가 실제로 안 돈다** — 나사가 안 도는데 손목만 도는 일은 없다.
# 그래서 "돌리라고 했는데 움직임이 없다" 가 성공일 수도(착좌) 실패일 수도(빗물림) 있고,
# 둘을 가르는 것은 **그때까지 실제로 돈 회전수**다. 실물에서 사람이 하는 판단과 같다.
#
# ⚠ **`depth` 는 시뮬만 아는 값이다** — 실기 FR5 에 깊이 센서가 없다. 그래서 **종료 판단은
#   실기에서도 읽히는 것(실제 j6 회전)으로만** 하고, `depth` 는 채점에만 쓴다.
SEAT_TURNS     = SCREW_TRAVEL / THREAD_PITCH     # [기하] 얹은 뒤 착좌까지 = 6.25바퀴
STALL_SPIN_MIN = 0.3 * SPIN_SCALE                # 이만큼은 돌리라고 해야 '돌리는 중'
STALL_ADV_EPS  = THREAD_PITCH * 1e-3             # 이보다 안 나가면 '안 나간다'


class FR5ScrewAssemblyEnv(gym.Env):
    """
    행동 (6) : [dx, dy, dz, d_tiltx, d_tilty, d_spin]
    관측 (15): 길이는 cm, 각도는 rad 로 스케일을 맞춰 넘긴다.

    FleetViewer 호환을 위해 robot_ee_pos / bullet_casing_pos 속성명은 유지한다.
    """

    metadata = {"render_modes": ["human"], "render_fps": 30}

    # ── 보상 변형 스위치 (기본값 = 정상 동작) ────────────────────────────
    # 발표용 '실패 양상' 정책을 재현할 때만 서브클래스에서 뒤집는다.
    # False 로 두면 이 프로젝트 초기에 실제로 발생했던 reward hacking
    # (물림 보너스를 노리고 물림<->역회전을 무한 반복)이 그대로 재현된다.
    ENGAGE_BONUS_ONCE = True
    REQUIRE_PULL_TO_DISENGAGE = True
    REGRIP_PENALTY = REGRIP_COST      # 크게 올리면 '한 스트로크만 돌리고 멈추는' 정책이 된다
    FASTEN_WEIGHT = 1500.0            # 낮추면 물려도 돌릴 이유가 없어 멈춘다
    SPIN_SCALE_FACTOR = 1.0           # 낮추면 회전이 느려 시간 안에 못 잠근다

    # ── 빗물림·스톨 — `CROSSTHREAD_CAP = 0` 이면 이전 물리와 완전히 동일하다 ──
    CROSSTHREAD_CAP  = 0.6      # 최악 편심(2.5mm)에서 깊이 상한을 60% 깎는다 (7 → 2.8mm)
    STALL_CONFIRM    = 3        # 연속 N 스텝이어야 스톨 확정 (한 스텝은 우연일 수 있다)
    STALL_TERMINATES = True     # 스톨이면 에피소드를 끝낸다 — 실물도 거기서 멈춘다
    SEAT_TURN_RATIO  = 0.9      # 착좌로 인정할 최소 실제 회전수 (SEAT_TURNS 대비)
    DESCENT_WEIGHT = 25.0             # 0 으로 두면 내려갈 이유가 없어 위에서 배회만 한다
    JAM_PENALTY_BASE = JAM_PENALTY        # 0 으로 두면 마음껏 문지르는 정책이 된다
    JAM_ESCALATION_RATE = JAM_ESCALATION  # 문지름 누적에 따른 페널티 증가율
    JAM_LIMIT_STEPS = JAM_LIMIT           # 0 으로 두면 폐기 없이 계속 문지를 수 있다

    def __init__(self, render_mode=None, env_id=0):
        super().__init__()
        self.render_mode = render_mode
        self.env_id = env_id
        self.action_space = spaces.Box(-1.0, 1.0, shape=(6,), dtype=np.float32)
        self.observation_space = spaces.Box(-np.inf, np.inf, shape=(15,), dtype=np.float32)
        self.bullet_casing_pos = np.array([0.0, 0.0, CASE_CENTER_Z])
        self.reset()

    # ── 상태 조회 헬퍼 ────────────────────────────────────────────────────
    @property
    def tip_z(self):
        """탄두 나사 선단의 높이."""
        return self.robot_ee_pos[2] - TCP_TO_TIP

    @property
    def lateral(self):
        """탄피 축(0,0) 기준 편심."""
        return float(np.linalg.norm(self.robot_ee_pos[:2]))

    @property
    def tilt(self):
        """툴 축이 연직에서 벗어난 각도."""
        return float(np.linalg.norm(self.tool_tilt))

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.robot_ee_pos = np.array([
            self.np_random.uniform(-0.010, 0.010),
            self.np_random.uniform(-0.010, 0.010),
            START_Z,
        ])
        self.tool_tilt = self.np_random.uniform(-np.deg2rad(5), np.deg2rad(5), size=2)
        self.spin = 0.0            # 체결 누적 회전각 (시각화용)
        self.wrist = -WRIST_LIMIT  # j6 실제 각도 (스트로크 시작점)
        self.depth = 0.0           # 나사 체결 깊이
        self.engaged = False
        self.ever_engaged = False   # 물림 보너스는 에피소드당 1회만
        self.regrips = 0
        self.depth_milestone = 0
        self.jam_steps = 0          # 에피소드 내 누적 문지름 스텝 (손상 누적)
        self.depth_cap = SEAT_DEPTH     # 물림 순간의 편심이 정한다 (빗물림이면 낮아진다)
        self.stall_steps = 0            # 연속 스톨 스텝
        self.success_awarded = False    # 성공 보상은 에피소드당 1회 (아래 §채점 주석)
        self.turns = 0.0                # **실제로 돈** 회전수 — 지령이 아니라 결과다
        self.contact_force = 0.0   # 축방향 접촉력 proxy
        self.side_force = 0.0      # 측방향(구속 반력) proxy
        self.current_step = 0
        # 시각화 호환: 기존 코드가 robot_ee_ori 를 참조해도 깨지지 않도록 유지
        self.robot_ee_ori = np.array([self.tool_tilt[0], self.tool_tilt[1], self.spin])
        return self._get_obs(), {}

    def _get_obs(self):
        return np.array([
            self.robot_ee_pos[0] * 100.0,
            self.robot_ee_pos[1] * 100.0,
            (self.tip_z - MOUTH_Z) * 100.0,
            self.tool_tilt[0],
            self.tool_tilt[1],
            self.lateral * 100.0,
            self.tilt,
            self.depth * 100.0,
            self.depth / SEAT_DEPTH,
            1.0 if self.engaged else 0.0,
            self.contact_force,
            self.side_force,
            np.sin(self.spin),
            np.cos(self.spin),
            # 누적 문지름(손상). 이 값이 관측에 없으면 페널티가 커져도 정책은
            # '이미 많이 비볐다'를 알 수 없어 물러설 근거가 없다.
            self.jam_steps / 25.0,
        ], dtype=np.float32)

    def step(self, action):
        self.current_step += 1
        action = np.clip(np.asarray(action, dtype=np.float64), -1.0, 1.0)
        d_pos  = action[:3] * POS_SCALE
        d_tilt = action[3:5] * TILT_SCALE
        d_spin = action[5] * SPIN_SCALE * self.SPIN_SCALE_FACTOR

        reward = -0.20                      # 시간 페널티 (제자리 대기 억제)
        self.contact_force = 0.0
        self.side_force = 0.0
        jammed = False
        scrapped = False        # 결합면 손상으로 폐기됐는지
        advance = 0.0

        if not self.engaged:
            # ── 1단계: 자유 접근 ──────────────────────────────────────────
            self.robot_ee_pos = self.robot_ee_pos + d_pos
            self.tool_tilt = np.clip(self.tool_tilt + d_tilt, -0.5, 0.5)

            if self.tip_z <= MOUTH_Z:
                if self.lateral <= ENTRY_TOL and self.tilt <= TILT_TOL:
                    # 정렬 성공 -> 입구 통과, 나사 물림 시작
                    self.engaged = True
                    # [실측 2026-09-07] 얹는 순간 이미 PLACED_DEPTH 만큼 들어가 있다.
                    # 0 에서 시작하면 회전으로 THREAD_DEPTH 를 다 넣어야 해서 실물보다 많이 요구한다.
                    self.depth = PLACED_DEPTH
                    self.robot_ee_pos[2] = MOUTH_Z + TCP_TO_TIP
                    # ⚠️ 이 보너스를 매번 주면 '물림 -> 역회전으로 빠짐 -> 재물림' 을
                    #    무한 반복하며 보상만 긁어모으는 reward hacking 이 생긴다.
                    if not self.ever_engaged or not self.ENGAGE_BONUS_ONCE:
                        self.ever_engaged = True
                        reward += 200.0
                    # 편심이 THREAD_TOL 밖이면 비스듬히 물린 셈 -> 감점
                    if self.lateral > THREAD_TOL:
                        bad = (self.lateral - THREAD_TOL) / (ENTRY_TOL - THREAD_TOL)
                        reward -= 40.0 * bad
                        # **그리고 물리적 결과를 준다** — 비뚤게 문 만큼 얕게 막힌다.
                        # 감점만으로는 성공 보상 2000점 앞에서 무시된다 (머리주석 §빗물림)
                        self.depth_cap = SEAT_DEPTH * (1.0 - self.CROSSTHREAD_CAP * bad)
                else:
                    # 정렬 실패 -> 입구 턱에 걸려 더 내려가지 못한다.
                    # 실물에서는 탄두가 탄피 결합면을 문지르며 나사산·모서리를 상하게 하므로
                    # 단순히 '진행 못 함'이 아니라 확실한 손해가 되도록 페널티를 크게 준다.
                    # (JAM_PENALTY 를 낮추면 정렬 전에 내려가 문지르는 정책이 학습된다)
                    jammed = True
                    self.robot_ee_pos[2] = MOUTH_Z + TCP_TO_TIP
                    self.contact_force = 1.0
                    # 누적 손상: 계속 비빌수록 스텝당 비용이 커진다
                    reward -= self.JAM_PENALTY_BASE * min(
                        1.0 + self.JAM_ESCALATION_RATE * self.jam_steps,
                        JAM_PENALTY_CAP)
                    self.jam_steps += 1
                    if self.JAM_LIMIT_STEPS and self.jam_steps >= self.JAM_LIMIT_STEPS:
                        scrapped = True          # 결합면 손상 -> 부품 폐기, 에피소드 종료
                        reward -= SCRAP_PENALTY

            # 접근 셰이핑: 편심 / 기울기 / 하강
            #
            # ⚠️ 하강 항에 정렬 게이트를 곱하면 안 된다. 정렬되는 순간 숨어 있던
            #    하강 페널티가 드러나 '정렬 자체가 손해'가 되고, 학습이 통째로 실패한다.
            #    (실측: 게이트 적용판 성공률 0%)
            #    대신 편심·기울기 가중치를 키워, 내려가기 전에 축을 맞추는 편이
            #    이득이 되도록 만든다. 이것이 결합면을 문지르는 동작(jam)을 줄인다.
            reward -= 80.0 * self.lateral
            reward -= 20.0 * self.tilt
            reward -= self.DESCENT_WEIGHT * max(0.0, self.tip_z - MOUTH_Z)

        else:
            # ── 2단계: 나사 체결 (축방향 전진은 회전으로만 발생) ──────────
            # **막히면 j6 가 실제로 안 돈다.** 나사가 안 도는데 손목만 도는 일은 없다 —
            # 지령(`d_spin`)과 실제(`eff_spin`)를 가르고 손목은 실제만큼만 돌린다.
            # 이 한 줄이 "돌리라고 했는데 움직임이 없다" 를 **실기에서도 읽히는 신호**로
            # 만든다 (실기에서는 지령 각도 vs 엔코더 각도의 차이로 같은 것을 본다).
            want    = (d_spin / (2.0 * np.pi)) * THREAD_PITCH   # 이만큼 나가려 했다
            room_up = self.depth_cap - self.depth               # 더 깊이 갈 여유
            room_dn = PLACED_DEPTH - self.depth                 # 풀려 나올 여유 (음수)
            advance = min(max(want, room_dn), room_up)
            blocked = want > room_up + STALL_ADV_EPS and d_spin > STALL_SPIN_MIN
            eff_spin = (advance / THREAD_PITCH) * 2.0 * np.pi   # 실제로 돈 각도

            self.wrist += eff_spin
            if self.wrist > WRIST_LIMIT:
                # j6 가동범위 소진 -> 재파지 후 스트로크 재시작 (이 스텝은 전진 없음)
                self.wrist = -WRIST_LIMIT
                self.regrips += 1
                reward -= self.REGRIP_PENALTY
                advance = 0.0
                self.stall_steps = 0    # 재파지도 전진 0 이지만 **착좌가 아니다**
            else:
                self.depth = float(np.clip(self.depth + advance, PLACED_DEPTH, self.depth_cap))
                self.spin += eff_spin
                # **실제로 돈** 회전수만 센다 — 막힌 채 헛돌리는 지령은 안 쌓인다.
                # 지령을 세면 빗물림으로 멈춘 뒤에도 계속 돌려 착좌 회전수를 채워 버린다
                self.turns += max(0.0, eff_spin) / (2.0 * np.pi)
                self.stall_steps = self.stall_steps + 1 if blocked else 0

            # 체결 중에는 편심·기울기가 나사산에 의해 기계적으로 구속된다.
            # 억지로 밀면 반력이 커지고 나사산이 상한다 -> 측력 페널티
            self.side_force = float(np.linalg.norm(d_pos[:2]) / POS_SCALE
                                    + np.linalg.norm(d_tilt) / TILT_SCALE)
            self.robot_ee_pos[0] = 0.0
            self.robot_ee_pos[1] = 0.0
            self.tool_tilt[:] = 0.0
            self.robot_ee_pos[2] = MOUTH_Z - self.depth + TCP_TO_TIP

            reward += self.FASTEN_WEIGHT * advance / SEAT_DEPTH
            reached_mm = int(self.depth * 1000.0)
            if reached_mm > self.depth_milestone:      # 1mm 단위 중간 성취 보상
                reward += 50.0 * (reached_mm - self.depth_milestone)
                self.depth_milestone = reached_mm
            reward -= 0.5 * self.side_force
            reward -= 0.3 * abs(action[2])          # 불필요한 축방향 밀어넣기
            self.contact_force = min(1.0, 0.3 + 0.7 * (self.depth / SEAT_DEPTH))
            if blocked:
                self.contact_force = 1.0    # 막힌 채 돌리면 축방향 반력이 최대다

            if self.depth <= PLACED_DEPTH and d_spin < 0 and (
                    action[2] > 0.5 or not self.REQUIRE_PULL_TO_DISENGAGE):
                # 완전히 풀린 상태에서 위로 빼내야 비로소 빠진다
                self.engaged = False

        self.robot_ee_ori = np.array([self.tool_tilt[0], self.tool_tilt[1], self.spin])

        # `success` 는 **실제로 다 잠겼나** — 채점용이다. `depth` 를 직접 본다.
        # ⚠ **보상은 에피소드당 한 번만.** 스톨로 끝내게 되면서 성공 뒤에도 스텝이
        #    이어지는데, 매 스텝 주면 착좌한 채 가만히 있는 것만으로 2000점을
        #    무한히 긁는다 (물림 보너스의 `ENGAGE_BONUS_ONCE` 와 같은 계열의 구멍이다).
        success = self.engaged and self.depth >= SEAT_DEPTH - 1e-9
        if success and not self.success_awarded:
            self.success_awarded = True
            reward += 2000.0

        # `seated_by_stall` 은 **실기에서도 내릴 수 있는 판단**이다 — 깊이를 안 본다.
        #   ①돌리라고 했는데 실제로 안 돈다  ②그때까지 실제로 돈 회전수가 착좌값에 닿았다
        # 빗물림은 얕은 데서 막히므로 ②에서 갈린다. 둘이 어긋나는 빈도가 곧
        # 「실기에서 이 판정을 믿어도 되나」의 답이다 (`info` 에 둘 다 싣는다).
        stalled = self.stall_steps >= self.STALL_CONFIRM
        seated_by_stall = bool(stalled and self.turns >= self.SEAT_TURN_RATIO * SEAT_TURNS)

        # **`STALL_TERMINATES` 가 켜지면 `success` 로 끝내지 않는다.** 실물은 다 잠긴
        # 순간을 알 수 없다 — 계속 돌려 보고 **안 돌아갈 때** 비로소 안다. 깊이로 끝내면
        # 그 확인 동작을 정책이 배울 이유가 없어지고, 판정이 실기로 안 넘어간다.
        # 끄면 이전과 같다 (깊이로 즉시 종료).
        terminated = bool(scrapped
                          or (stalled if self.STALL_TERMINATES else success))
        truncated = self.current_step >= MAX_STEPS
        info = {
            "depth_mm": self.depth * 1000.0,
            "engaged": self.engaged,
            "regrips": self.regrips,
            "jammed": jammed,
            "jam_steps": self.jam_steps,
            "scrapped": scrapped,
            "is_success": success,
            # ── 스톨 기반 관측 판정 (실기 이식용) ──────────────────────────
            "depth_cap_mm": self.depth_cap * 1000.0,
            "crossthread": bool(self.depth_cap < SEAT_DEPTH - 1e-9),
            "turns": self.turns,
            "stall_steps": self.stall_steps,
            "stalled": stalled,
            "seated_by_stall": seated_by_stall,
        }
        return self._get_obs(), float(reward), terminated, truncated, info

    def render(self):
        return None

    def close(self):
        return None
