#!/usr/bin/env python3
"""SAM 3 + 깊이 기반 탄두/탄피 픽 — ROS2 비주얼 서보잉.

vision_pick_and_place.py 의 ROS2/FR5 제어 방식을 따르되,
ArUco 마커 대신 SAM 3 + 깊이 분류로 대상을 찾는다.

동작
  1. SAM 3로 탄두/탄피를 찾고 우선순위로 대상 하나를 고른다
     (탄피 → 탄두, 같은 종류면 로봇에 가까운 쪽)
  2. 대상이 화면 중심에 올 때까지 X/Y를 반복 이동한다 (비주얼 서보잉)

핸드아이 캘리브레이션도, 야코비안 학습도 필요 없다.
픽셀 오차는 깊이와 초점거리로 바로 mm 로 바꾼다 (mm = px * Z / fx).
남는 자유도는 화면 축과 로봇 축의 대응뿐이라 --map / --sign 으로 지정한다.

⚠️ 기본은 미리보기(dry-run)다 — 계산만 하고 로봇을 움직이지 않는다.
⚠️ 시작 위치까지는 --move 없이도 실제로 간다. 안 가면 카메라가 작업대를 안 본다.
⚠️ --move 로 서보 이동하기 전에 로봇 주변을 비우고
   비상정지에 손이 닿는 상태에서 진행할 것. 저속·소폭 이동으로 제한했다.

사용법
  python3 sam3_pick_ros2.py                    # 미리보기: 대상 선정과 목표만 출력
  python3 sam3_pick_ros2.py --move             # 중심 정렬까지만
  python3 sam3_pick_ros2.py --move --hold      # 정렬 후 그 자리에서 대기
  python3 sam3_pick_ros2.py --descend          # 정렬 → 상대 하강 → 그리퍼 22 로 파지

사전 준비
  터미널 1: ros2 launch realsense2_camera rs_launch.py align_depth.enable:=true
  터미널 2: ros2 run fairino_hardware_v3_9_7 ros2_cmd_server

  깊이는 컬러에 정렬된 토픽을 쓴다. align_depth.enable:=true 없이는 나오지 않는다.
""" 
import argparse, os, time, sys, json, threading, pathlib
import numpy as np, cv2, torch
from PIL import Image as _PILImage, ImageDraw as _PILDraw, ImageFont as _PILFont
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image, CameraInfo
from fairino_msgs.msg import RobotNonrtState
from fairino_msgs.srv import RemoteCmdInterface

# 그리퍼. 시작할 때 항상 28 로 벌리고, 하강을 마치면 22 로 잡는다 (탄두는 17).
GRIPPER_ID    = 1
GRIPPER_START = 28
GRIPPER_GRIP  = 22
GRIPPER_SPEED, GRIPPER_TORQUE, GRIPPER_MAXTIME = 5, 15, 2000

# 시작 위치 (관절값, 도). 실측해서 넣은 값 — home_pose.json 과 같다.
# 2026-09-12 교시로 잡은 시작 위치. TCP (315.09, -934.32, 22.76),
# 자세 (-158.606, -2.129, 178.805) — 공구가 21.6도 기울어 있다.
# ⚠️ 파지 보정값은 자세 179.766 에서 잰 값이므로 이 홈에서는 무효다.
#    --save-grip-offset 으로 다시 실측해야 하강할 수 있다.
# 이전 홈 (탄피 5회 완주·탄두 파지 검증에 쓰인 값):
#   [71.232, -77.373, 88.429, -100.799, -89.955, -18.064]   자세 (179.766, 0.124, 179.307)
HOME_JOINTS = [59.232, -107.890, 116.637, -118.487, -81.375, -28.476]

# 놓을 위치와 경유점 — 절대 카테시안 (x, y, z, rx, ry, rz) mm/도. 둘 다 None 이면
# 들어올린 자리에서 끝낸다(좌표를 다시 잡을 때 그렇게 쓴다).
#
# 두 지점의 X/Y 를 같게 잡을 것 — 그러면 마지막 하강이 순수 수직이 되어
# 트레이 벽을 치지 않는다.
# 경유점 없이 파지 위치에서 놓을 위치로 곧장 카테시안 이동하면 경로가 나빠진다 —
# 09-10 에 목표에서 626mm 어긋나 비상정지했고, 급정지 중 6축이 슬레이브에서
# 탈락해 컨트롤 박스 전원 재투입이 필요했다.
#
# 잡는 법: 두 상수를 None 으로 두고 --descend 를 돌리면 물체를 든 채 멈춘다.
#          Jog 으로 각 지점에 맞춘 뒤 TCP·자세를 읽어 여기에 넣는다.
#
# 2026-09-11 Jog 실측. X/Y 가 0.01mm 이내로 같아 ⑪이 순수 수직 82mm 하강이다.
# 자세도 두 지점 동일하며 파지 자세(rx=179.77, ry=0.12)와 같다 —
# 파지 후 자세를 바꾸지 않으므로 rx 부호가 뒤집히는 경로가 생기지 않는다.
# 참고 관절  경유점 = [58.654, -58.569, 77.165, -108.336, -90.010, -30.654]
#            놓을곳 = [58.654, -54.068, 82.733, -118.405, -90.010, -30.654]
PLACE_APPROACH = [125.969, -1145.936, -189.006, 179.766, 0.124, 179.307]
PLACE_POSE     = [125.971, -1145.926, -271.083, 179.766, 0.124, 179.307]

# 박아 넣는 구간 — 놓을 위치에서 1mm 씩 세 번 더 내려간다. 물체를 쥔 채로 누르고,
# 끝난 뒤에 그리퍼를 벌린다. 한 번에 3mm 내리지 않고 나누는 이유는
# 걸리면 그 단계에서 멈춰 어느 깊이에서 막혔는지 알 수 있기 때문이다.
# 비우면([]) 박지 않고 놓을 위치에서 바로 벌린다.
PLACE_PRESS = [
    [125.971, -1145.926, -272.083, 179.766, 0.124, 179.307],   # -1mm
    [125.971, -1145.926, -273.083, 179.766, 0.124, 179.307],   # -2mm
    [125.971, -1145.926, -274.083, 179.766, 0.124, 179.307],   # -3mm
]

# ---------------------------- 종류별 시퀀스 ----------------------------
# 검출된 종류에 따라 파지 보정값과 놓기 좌표가 달라진다.
#   grip     정렬 좌표에서 파지 지점까지의 상대 (dx, dy, dz) mm
#   approach 경유점 (절대 카테시안 6값)
#   pose     놓을 위치 (절대 카테시안 6값)
#   press    놓을 위치 기준 박기 깊이 (mm, 음수). [] 면 박지 않는다
#   after    박기를 마친 지점에서 이어서 갈 상대 이동 [(dx,dy,dz), ...] mm.
#            박기의 마지막 좌표 다음에 덧붙는 단계다 (교체가 아니다)
#   close    파지할 때의 그리퍼 값 (작을수록 닫힘)
#   back     놓은 뒤 경유점·홈으로 복귀할지. False 면 놓은 자리에 멈춘다
#   release  놓을 자리에서 그리퍼를 벌릴지. False 면 쥔 채로 멈춘다
#
# None 인 항목이 있으면 그 단계에서 멈추고 무엇을 재야 하는지 알려준다.
# 탄두는 길이가 13~15mm(탄피 20mm)라 파지 깊이가 다를 것으로 보여 실측 대기 중이다.
KIND_CFG = {
    "탄피": {
        "grip":     "json",          # grip_offset.json 의 실측값을 쓴다 (탄피 기준으로 잰 값)
        "approach": PLACE_APPROACH,
        "pose":     PLACE_POSE,
        "press":    [-1.0, -2.0, -3.0],
        "close":    GRIPPER_GRIP,
        "release":  True,
        "back":     True,
    },
    "탄두": {
        # 2026-09-13 실측. 탄피와 같은 방식의 상대 이동이다 — 정렬(자세 -158.6) 후
        # 21.6도 제자리 회전을 마친 자리 (310.406, -1065.174, -29.934) 에서
        # 파지 지점 (334.049, -1269.893, -284.802) 까지. 자세 차이 0.001도로 순수 병진.
        # 뒤 3개는 파지 자세(절대) — 하강 전에 이 자세로 회전한다.
        # 09-11 값 [38.23, -87.87, -200.99] 은 옛 홈·수직 정렬 기준이라 폐기.
        # 09-13 탄두 전체 10차 후 Z -2mm 보정 (실측 dz -254.87 → -256.87).
        "grip":     [23.64, -204.72, -256.87, 179.768, 0.124, 179.307],
        # 2026-09-13 실측. 절대 고정좌표 경유점. 참고 관절 = [58.772, -56.173, 80.679, -114.246, -90.008, -30.536]
        # 놓을 위치보다 Y +4.006, Z +9.003mm — 비스듬히 들어가 셀에 끼운다.
        "approach": [127.305, -1146.511, -236.496, 179.767, 0.125, 179.307],
        # 2026-09-13 실측. 절대 고정좌표 놓을 위치. 참고 관절 = [58.772, -55.535, 81.377, -115.582, -90.008, -30.536]
        # 탄두는 여기서 돌려 끼워야 해서 **여기서 정지**하고 강화학습 정책을 기다린다 —
        # 박기·마무리·파지 풀기·복귀 없음. 쥔 채로 이 자세를 넘겨준다.
        "pose":     [127.306, -1146.513, -247.498, 179.767, 0.125, 179.307],
        "press":    [],
        "after":    [],
        "close":    16,              # 탄두가 탄피보다 얇아 더 조인다 (탄피는 22). 09-13: 17 → 16 시험
        "lift":     80.0,            # 09-13. 파지 후 상대좌표로 Z +80mm (탄피는 --lift-mm 기본 100)
        "release":  False,           # 파지를 풀지 않는다 — 쥔 채로 멈춘다
        "back":     False,           # 놓은 자리에서 멈춘다 — 강화학습 대기
    },
}


def kind_cfg(kind):
    """검출된 종류의 설정을 돌려준다. 인자로 준 값이 있으면 그게 이긴다."""
    c = dict(KIND_CFG.get(kind) or {})
    # grip 은 3개(dx,dy,dz) 또는 6개(dx,dy,dz + 파지 자세 절대 rx,ry,rz)다.
    if a.grip_offset:   c["grip"]     = [float(v) for v in a.grip_offset.split(",")]
    if a.place_approach: c["approach"] = [float(v) for v in a.place_approach.split(",")]
    if a.place_pose:     c["pose"]     = [float(v) for v in a.place_pose.split(",")]
    if a.place_press is not None:
        c["press"] = [float(v) for v in a.place_press.split(",") if v.strip()]
    if c.get("grip") == "json":
        # "json" 이라고 명시한 종류만 grip_offset.json 을 쓴다.
        # None 인 종류(실측 전)는 그대로 None 이어서 그 단계에서 멈춘다.
        c["grip"] = GRIP_JSON
    return c

HERE = os.path.dirname(os.path.abspath(__file__))
ALIGNED_FILE = os.path.join(HERE, "aligned_poses.json")   # 정렬 완료 기록(누적)
GRIP_FILE    = os.path.join(HERE, "grip_offset.json")     # 보정값 실측 결과

# 자세는 상수로 박지 않는다. 교재의 -179.224/1.509/91.191 은 그쪽 실습 로봇의
# 공구 설정에 맞춘 값이라, 다른 공구 좌표계에서 쓰면
# "Straight line target point error (including tool discrepancy)" 로 거부된다.
# 서보는 X/Y 만 옮기므로 자세를 바꿀 이유가 없다 — 현재 자세를 그대로 유지한다.
APPROACH_RX = APPROACH_RY = APPROACH_RZ = None   # cur_rpy() 로 매번 읽는다

ap = argparse.ArgumentParser()
ap.add_argument("--move",  action="store_true", help="중심 정렬까지 실제 이동")
ap.add_argument("--speed", type=int, default=5,
                help="서보 정렬 속도 %%. 보폭이 1~15mm 라 낮게 둔다")
ap.add_argument("--speed-move", type=int, default=10,
                help="정렬 이후 큰 이동(보정·하강·들어올리기·경유점·놓기) 속도 %%. "
                     "가감속 편차가 속도에 따라 달라지므로 바꾸면 보정값을 다시 확인할 것")
ap.add_argument("--movecmd", default="MoveL", choices=["MoveL","MoveJ"],
                help="MoveL=직선(서보 보정에 적합, 기본) / MoveJ=관절 보간")
ap.add_argument("--tool", type=int, default=-1,
                help="공구 좌표계 번호. 미지정이면 GetActualTCPNum 으로 읽는다")
ap.add_argument("--user", type=int, default=-1,
                help="공작물 좌표계 번호. 미지정이면 GetActualWObjNum 으로 읽는다")
ap.add_argument("--offset-frame", type=int, default=1, choices=[0, 1, 2],
                help="상대 이동 기준. 1=공작물/베이스, 2=공구. 0이면 절대좌표 방식으로 되돌린다")
ap.add_argument("--rpy", default=None,
                help='자세를 고정하고 싶을 때 "rx,ry,rz". 미지정이면 현재 자세를 유지한다')
# 서보잉
ap.add_argument("--center-x", type=int, default=-1, help="그리퍼 TCP가 오는 화면 좌표. 미지정이면 화면 중앙")
ap.add_argument("--center-y", type=int, default=-1)
ap.add_argument("--tol-px", type=float, default=4.0,
                help="중심 허용 오차(px). 0이면 물체 반크기로 자동 (중심이 물체 안에 들어오면 정지). "
                     "거리 260mm·fx=604.5 에서 0.43mm/px 이므로 4px = 약 1.7mm. "
                     "09-11 에 5 → 4 로 조임 (대기 중 실측 안정성 표준편차 0.024px)")
ap.add_argument("--tol-min-px", type=float, default=3.0, help="자동 허용오차의 하한")
ap.add_argument("--sequential", dest="simultaneous", action="store_false",
                help="X 를 먼저 맞추고 그다음 Y (09-11 이전 기본). "
                     "축을 하나씩 움직여 --sign 진단이 쉽지만, Y 를 맞추는 동안 X 가 틀어져 "
                     "최종 재정렬이 매번 필요하고 회차가 10~13회로 늘어난다")
ap.set_defaults(simultaneous=True)   # 09-11 기본 전환: X·Y 동시가 5회에 2.7px 로 수렴
ap.add_argument("--gain", type=float, default=0.6, help="서보 게인. 1.0이면 한 번에 목표까지")
ap.add_argument("--max-step-mm", type=float, default=15.0, help="1회 이동 상한")
ap.add_argument("--lost-timeout", type=float, default=0,
                help="대상을 놓친 뒤 이만큼(초) 지나도 안 나타나면 종료. 0이면 무한 대기")
ap.add_argument("--max-iter", type=int, default=200,
                help="안전 상한. 정상 종료 조건은 '중심에 맞음'이고, 이 값은 무한 이동을 막는 보호장치다")
# 픽셀 오차 → 로봇 이동량은 깊이와 초점거리로 바로 구한다 (mm = px * Z / fx).
# 남는 건 화면 축과 로봇 축의 대응뿐이라, 아래 두 값으로 지정한다.
ap.add_argument("--map", default="u:x,v:y", choices=["u:x,v:y", "u:y,v:x"],
                help="화면 u/v 가 로봇 어느 축에 대응하는지. 카메라가 90도 돌아 있으면 u:y,v:x")
ap.add_argument("--sign", default="+,+",
                help='이동 부호 "sx,sy". 화면에서 반대로 가면 부호를 뒤집는다. 예: "-,+"')
ap.add_argument("--hold", action="store_true",
                help="정렬 후 그 자리에서 대기하며 오차를 계속 표시한다 (Ctrl+C 로 종료)")
ap.add_argument("--hold-redo", action="store_true",
                help="대기 중 오차가 허용치를 넘으면 다시 정렬한다. 기본은 표시만 하고 움직이지 않는다")
ap.add_argument("--kind", default="any", choices=["any", "탄피", "탄두"],
                help="집을 종류를 고정한다. any 면 우선순위(탄피 → 탄두)를 따른다. "
                     "분류가 흔들려 대상이 갈아타는 걸 막는다")
ap.add_argument("--track-radius-px", type=float, default=60.0,
                help="추적 반경. 직전 대상 위치에서 이 안에 있는 검출을 같은 물체로 본다")
ap.add_argument("--regain-radius-px", type=float, default=90.0,
                help="놓쳤다 다시 나타났을 때, 마지막 위치에서 이 안이면 같은 물체로 이어간다")
ap.add_argument("--robot-side", default="bottom", choices=["bottom","top","left","right"],
                help="화면에서 로봇이 있는 방향. 같은 종류면 가까운 쪽 먼저")
# 검출/분류 (run_sam3_depth.py 와 동일 기본값)
ap.add_argument("--prompt", default="bullet,metal ring",
                help='SAM3 텍스트 프롬프트. 콤마로 여러 개. '
                     '자세에 따라 맞는 표현이 다르므로 병행한다 — 09-10 실측 점수: '
                     '비스듬히 보이는 꽂힌 탄피는 bullet 이 통하지만, '
                     '수직으로 내려다본 링은 bullet 0.029 / metal ring 0.703 이라 '
                     'bullet 만으로는 --threshold 0.15 를 못 넘는다. '
                     'circle(0.867) 은 격자 셀 구멍을, small metal object(0.848) 는 '
                     '고정대까지 잡아 오검출이 늘어난다')
ap.add_argument("--repo", default="facebook/sam3")
ap.add_argument("--threshold", type=float, default=0.4)
ap.add_argument("--pose-aspect", type=float, default=2.2)
ap.add_argument("--center-bright", type=float, default=10.0)
ap.add_argument("--taper-th", type=float, default=0.15)
ap.add_argument("--min-height-mm", type=float, default=1.0)
ap.add_argument("--min-len-mm", type=float, default=12.0,
                help="실제 길이 하한. 실측: 실물 15.0~23.1 / 조인트·노이즈 4.0~9.0")
ap.add_argument("--max-len-mm", type=float, default=45.0)
ap.add_argument("--z-split-mm", type=float, default=268.0,
                help="꽂힌 물체의 종류를 카메라 거리로 가른다. 이 값보다 가까우면 탄피, "
                     "멀면 탄두. 같은 평면에 꽂혀 있으면 긴 쪽(탄피 21mm)이 카메라에 "
                     "가깝다. 09-11 실측: 탄피 260mm / 탄두 277~284mm 로 17mm 이상 벌어져 "
                     "길이 기준(탄두 14.3 / 탄피 15.8, 1.5mm 차이)보다 훨씬 안전하다. "
                     "0 이면 길이 기준(--len-split-mm)을 쓴다. "
                     "절대 거리이므로 시작 위치를 다시 잡으면 재측정할 것")
ap.add_argument("--len-split-mm", type=float, default=17.0,
                help="꽂힌 물체 길이 경계. 경계 ±1.5mm 안이면 길이를 못 믿고 중심 밝기로 판정한다. "
                     "실측 09-09 거리 260mm: 탄두 15.0~18.0 / 탄피 21.1~21.5. "
                     "실측 09-10 거리 285mm: 탄두 13.3~13.9 / 탄피 20.0. "
                     "20.0 이면 탄피가 경계에 정확히 걸려 밝기 판정으로 넘어가 분류가 뒤집혔다")
ap.add_argument("--min-area", type=int, default=300, help="마스크 픽셀 수 하한")
ap.add_argument("--max-area", type=int, default=5000,
                help="마스크 픽셀 수 상한. 물체는 500px 대인데 임계값을 낮추면 "
                     "트레이 전체 같은 큰 영역이 잡힌다 — 09-11 실측: 임계 0.08 에서 "
                     "27023px(화면의 9%%) 오검출. 0 이면 상한 없음")
ap.add_argument("--detector", default="sam3", choices=["sam3", "depth", "both", "plane"],
                help="검출 방식. sam3=텍스트 프롬프트, depth=깊이로 솟은 덩어리 찾기, "
                     "plane=scripts/run_sam3_depth.py 와 같은 파이프라인 (국소 평면 + 배경 "
                     "85분위 폴백, 면적·길이 필터 없음). 영상으로 검출이 잘 되는 것을 확인한 판이다. "
                     "both=둘 다 쓰고 합친다. depth 는 색·조명·프롬프트에 의존하지 않아 "
                     "검은 물체도 잡힌다 (09-11: metal ring 0.052 로 놓친 물체를 깊이로는 찾음)")
ap.add_argument("--split-y", type=int, default=185,
                help="종류를 가르는 화면 가로선의 y 픽셀. -1 이면 화면 세로 중앙. 09-12 실측 기본값 185 — 트레이 두 줄 사이 빈 틈의 중앙이다 (위 줄 아래 테두리 ~170, 아래 줄 위 테두리 ~200). "
                     "선 아래(카메라·로봇에 가까운 쪽)를 탄피, 위를 탄두로 본다. "
                     "0 이하 음수 대신 --split-y 0 을 주면 이 규칙을 끄고 기존 판정을 쓴다. "
                     "밝기 판정은 금속 반사에 흔들려 탄두를 탄피로 잡는 일이 많았다 — "
                     "물체를 줄로 나눠 놓는다면 위치가 훨씬 안정적인 근거다")
ap.add_argument("--with-lying", dest="standing_only", action="store_false", default=True,
                help="누운 물체도 대상으로 본다. 기본은 꽂힌 물체만 — 누운 물체는 파지 "
                     "보정값이 따로 필요한데 실측한 적이 없다")
ap.add_argument("--home-lift-mm", type=float, default=22.0,
                help="시작 위치에 도달한 뒤 Z 를 이만큼 더 올린다. 카메라가 높아져 작업대 "
                     "전체가 보이고, 꽂힌 물체가 위에서 링만 보이는 문제가 줄어든다 "
                     "(영상으로 확인한 판은 기준면 408mm — 현재 홈보다 약 82mm 높다). "
                     "⚠️ 올린 만큼 하강 보정값 dz 에 자동으로 더해진다 — 보정값은 원래 "
                     "정렬 Z(-86.6)에서 잰 값이라 그냥 올리면 하강이 부족해진다. "
                     "보상하면 파지 지점은 수학적으로 동일하다: (-86.6+82) + (-200.99-82) "
                     "= -287.6 으로 기존과 같다. 09-12 기본값 82 — 이 높이가 검출이 가장 "
                     "좋다 (기준면 409mm, 매 프레임 5개 안정, 오검출 0, 검은 물체도 잡힘). "
                     "0 을 주면 09-11 이전의 낮은 홈으로 돌아간다")
ap.add_argument("--plane-pct", type=float, default=85.0,
                help="[--detector plane] 마스크가 아닌 배경 깊이의 이 분위수를 기준면으로 쓴다. "
                     "국소 평면 적합이 실패한 물체에만 쓰이는 폴백이다")
ap.add_argument("--plane-mm", type=float, default=0.0,
                help="[--detector plane] 기준면을 이 깊이로 고정한다. 0 이면 --plane-pct 로 추정")
ap.add_argument("--depth-floor-pct", type=float, default=75.0,
                help="트레이 바닥 깊이를 ROI 깊이의 이 분위수로 추정한다(%%). "
                     "프레임마다 다시 재므로 카메라 높이가 바뀌어도 따라간다")
ap.add_argument("--depth-bump-mm", type=float, default=25.0,
                help="추정한 바닥보다 이만큼(mm) 얕으면 물체 후보로 본다. "
                     "09-11 실측: 바닥 322mm / 물체 260~290mm")
ap.add_argument("--depth-height-max", type=float, default=45.0,
                help="깊이 덩어리가 바닥보다 이만큼(mm) 넘게 솟으면 물체가 아니다. "
                     "탄피 21mm / 탄두 15mm 이므로 30mm 면 넉넉하다. "
                     "09-11 실측: 물체 h=43mm 이하, 트레이 테두리·벽 h=57~65mm. "
                     "0 이면 상한 없음")
ap.add_argument("--depth-aspect-max", type=float, default=1.6,
                help="깊이 덩어리의 종횡비 상한. 트레이 벽(3.1)·격자 리브(1.8)를 걸러낸다. "
                     "물체는 1.16 로 거의 정사각이다")
ap.add_argument("--require-both", action="store_true",
                help="--detector both 에서 SAM3 와 깊이가 모두 가리킨 위치만 채택한다. "
                     "SAM3 는 점수가 낮아도 위치는 맞히고, 깊이는 형태를 본다 — "
                     "둘이 합의하면 오검출이 크게 줄어든다. "
                     "09-11 실측: 깊이 단독 4개(진짜 1개) → 합의 요구 시 1개. "
                     "**첫 대상 선정에만 적용된다** — 서보로 카메라가 움직이면 SAM3 가 "
                     "물체를 못 보므로(09-11: 7회 연속 0개) 추적 중에는 깊이만 쓴다. "
                     "한 번 고른 대상은 track_target 이 직전 위치로 이어간다")
ap.add_argument("--dedup-px", type=float, default=15.0,
                help="중복 검출 제거 반경 px. 중심이 이 안에 있는 마스크는 같은 물체로 보고 "
                     "면적이 큰 것만 남긴다. 0 이면 제거하지 않는다. "
                     "프롬프트를 여러 개 쓰면 같은 물체가 여러 번 잡힌다 — "
                     "09-11 실측: 물체 3개가 검출 5개로 나왔고 그중 하나가 3중 검출이었다")
ap.add_argument("--ring-px", type=int, default=14)
ap.add_argument("--roi", default=None,
                help='검출 영역 "x1,y1,x2,y2" px. 미지정이면 화면 전체. '
                     '배치 전용 좌표를 기본값으로 박지 말 것 — 카메라를 옮기면 엉뚱한 영역이 남는다')
ap.add_argument("--exclude", action="append", default=None,
                help='제외 영역 "x1,y1,x2,y2" px. 여러 번 줄 수 있다. 미지정이면 없음')
ap.add_argument("--place-approach", default=None,
                help='경유점 "x,y,z,rx,ry,rz" 로 PLACE_APPROACH 를 덮어쓴다')
ap.add_argument("--place-pose", default=None,
                help='놓을 위치 "x,y,z,rx,ry,rz" 로 PLACE_POSE 를 덮어쓴다')
ap.add_argument("--place-press", default=None,
                help='박기 깊이 "dz1,dz2,..." mm (놓을 위치 기준 상대). '
                     '"" 이면 박지 않는다. 예: "-1,-2,-3"')
ap.add_argument("--place-h-ref", type=float, default=None,
                help="놓기 Y 보정의 기준 높이 h(mm). 정렬된 상태에서 잰 h 가 이보다 크면 Y+, "
                     "작으면 Y- 로 차이만큼 경유점·놓을 위치를 옮긴다. 미지정이면 보정하지 않는다")
ap.add_argument("--place-h-k", type=float, default=1.0,
                help="h 차이 1mm 당 Y 이동량(mm). 기본 1.0 — 차이만큼 그대로 옮긴다")
ap.add_argument("--place-h-max-mm", type=float, default=1.0,
                help="h 보정으로 놓을 위치 Y 를 옮기는 최대량(mm). 기본 1.0 — "
                     "h 가 튀어도 이 이상은 절대 옮기지 않는다 (09-12 8차: h 82.9 로 +72mm 날아감)")
ap.add_argument("--no-place", action="store_true",
                help="놓을 위치로 이동하지 않고 들어올린 자리에서 끝낸다")
ap.add_argument("--lift-mm", type=float, default=100.0,
                help="파지 후 상대좌표로 들어올릴 높이 mm. 0 이면 올리지 않는다")
ap.add_argument("--no-home", action="store_true",
                help="시작 위치로 이동하지 않고 현재 자리에서 시작한다. "
                     "지금 보이는 프레임을 그대로 진단할 때 쓴다")
ap.add_argument("--record-traj", default=None, metavar="경로",
                help="관절 궤적을 JSON 으로 기록한다. 유니티 TrajectoryPlayer 형식이라 "
                     "실기 동작을 그대로 재생할 수 있다 (예: --record-traj ../unity/traj_pick.json)")
ap.add_argument("--record-fps", type=float, default=25.0,
                help="궤적 샘플링 주기. 기존 traj_ep000.json 이 25fps 다")
ap.add_argument("--dry", action="store_true",
                help="로봇을 전혀 건드리지 않는다(시작 위치 이동도 안 함). 명령만 출력")
ap.add_argument("--no-servo", action="store_true",
                help="검출·서보를 건너뛰고 현재 위치에서 보정값만큼 상대 이동한다. "
                     "이미 정렬돼 있을 때 쓴다. 시작 위치로도 가지 않는다 "
                     "(홈으로 가면 정렬 기준이 날아간다)")
ap.add_argument("--descend", action="store_true",
                help="정렬 후 보정값만큼 상대 이동(하강)한다. 그리퍼는 건드리지 않는다")
ap.add_argument("--grip-offset", default=None,
                help='정렬 좌표에서 파지 지점까지의 "dx,dy,dz" mm. '
                     '미지정이면 grip_offset.json 에서 읽는다')
ap.add_argument("--save-grip-offset", action="store_true",
                help="직전 정렬 좌표와 현재 위치의 차이를 grip_offset.json 에 저장하고 종료한다. "
                     "정렬시킨 뒤 Jog 으로 그리퍼를 물체 파지 지점까지 옮기고 실행한다. "
                     "로봇을 움직이지 않고 읽기만 한다")
ap.add_argument("--display", action="store_true")
a = ap.parse_args()

a.center_x_set = a.center_x >= 0
a.center_y_set = a.center_y >= 0
DO_MOVE = a.move or a.descend or a.no_servo
TOOL, USER = 1, 1          # 시작 시 로봇에서 읽어 덮어쓴다
# 보정값(상대좌표): 인자 > grip_offset.json > 없음.
# 관절 차이가 아니라 TCP 차이(mm)만 상수로 쓸 수 있다 — 회전 관절이라
# 정렬 위치가 바뀌면 같은 병진을 만드는 관절 변화량이 달라진다.
GRIP_JSON = None
GRIP_LIFT_MM = None      # 보정값을 실측할 때의 시작 Z 상승분
if a.grip_offset:
    GRIP_JSON = [float(v) for v in a.grip_offset.split(",")]
    print(f"보정값: 인자에서 읽음 "
          f"({GRIP_JSON[0]:+.1f}, {GRIP_JSON[1]:+.1f}, {GRIP_JSON[2]:+.1f}) mm")
elif os.path.exists(GRIP_FILE):
    _gj = json.load(open(GRIP_FILE))
    # grip6 이 있으면 파지 자세까지 실측된 것이다 — 회전 후 병진으로 쓴다.
    GRIP_JSON = _gj.get("grip6") or _gj["dxyz"]
    GRIP_LIFT_MM = _gj.get("home_lift_mm")
    if len(GRIP_JSON) >= 6:
        print(f"보정값: {os.path.basename(GRIP_FILE)} 에서 읽음 (회전 포함) "
              f"({GRIP_JSON[0]:+.1f}, {GRIP_JSON[1]:+.1f}, {GRIP_JSON[2]:+.1f}) mm "
              f"+ 파지 자세 ({GRIP_JSON[3]:.2f}, {GRIP_JSON[4]:.2f}, {GRIP_JSON[5]:.2f})")
    else:
        print(f"보정값: {os.path.basename(GRIP_FILE)} 에서 읽음 "
              f"({GRIP_JSON[0]:+.1f}, {GRIP_JSON[1]:+.1f}, {GRIP_JSON[2]:+.1f}) mm")

_roi = tuple(float(v) for v in a.roi.split(",")) if a.roi else None
_ex  = [tuple(float(v) for v in e.split(",")) for e in (a.exclude or [])]

# ---------------------------- 인식부 ----------------------------
# --save-grip-offset 은 로봇 좌표만 읽으므로 모델·카메라가 필요 없다.
if not (a.save_grip_offset or a.no_servo or a.detector == "depth"):
    from transformers import Sam3Model, Sam3Processor
    t0 = time.time()
    model = Sam3Model.from_pretrained(a.repo, dtype=torch.bfloat16).to("cuda").eval()
    proc  = Sam3Processor.from_pretrained(a.repo)
    prompts = [x.strip() for x in a.prompt.split(",") if x.strip()]
    text_in = {q: proc(text=q, return_tensors="pt").to("cuda") for q in prompts}
    print(f"[load] SAM3 {time.time()-t0:.1f}s  prompt={prompts}")

TOPIC_COLOR = "/camera/camera/color/image_raw"
TOPIC_DEPTH = "/camera/camera/aligned_depth_to_color/image_raw"
TOPIC_INFO  = "/camera/camera/color/camera_info"

# 카메라 구독은 아래 ROS 노드 생성 뒤에 붙는다

def shape_feats(m):
    """(종횡비, 테이퍼, 길이px, 폭px)"""
    ys, xs = np.nonzero(m)
    if ys.size < 30: return 0.0, 0.0, 0.0, 0.0
    pts = np.stack([xs, ys], 1).astype(np.float32); pts -= pts.mean(0)
    _, _, vt = np.linalg.svd(pts, full_matrices=False)
    t, w = pts @ vt[0], pts @ vt[1]
    bins = np.linspace(t.min(), t.max(), 11); wd = []
    for i in range(10):
        s = (t >= bins[i]) & (t < bins[i+1])
        wd.append(w[s].max()-w[s].min() if s.sum() > 3 else 0.0)
    wd = np.array(wd); W = wd.max() if wd.max() > 0 else 1.0
    L = float(t.max()-t.min())
    return float(L/W), float(abs(wd[:3].mean()-wd[-3:].mean())/W), L, float(W)

def center_brightness(m, gray):
    ys, xs = np.nonzero(m)
    if ys.size < 40: return 0.0
    cy, cx = ys.mean(), xs.mean()
    r = np.hypot(ys-cy, xs-cx); rmax = r.max()
    if rmax < 3: return 0.0
    rn = r/rmax; prf = []
    for i in range(5):
        s = (rn >= i/5) & (rn < (i+1)/5)
        prf.append(gray[ys[s], xs[s]].mean() if s.sum() > 5 else np.nan)
    if np.isnan(prf[0]) or np.isnan(prf[2]): return 0.0
    return float(prf[0]-prf[2])

def local_plane_height(m, d, ring_px):
    k = np.ones((3,3), np.uint8); mu = m.astype(np.uint8)
    ring = cv2.dilate(mu,k,iterations=ring_px).astype(bool) & ~cv2.dilate(mu,k,iterations=3).astype(bool)
    ys, xs, zz = np.nonzero(ring)[0], np.nonzero(ring)[1], d[ring]
    ok = ~np.isnan(zz); ys, xs, zz = ys[ok], xs[ok], zz[ok]
    if zz.size < 60: return None
    A = np.stack([xs, ys, np.ones_like(xs)], 1).astype(np.float64)
    co, *_ = np.linalg.lstsq(A, zz.astype(np.float64), rcond=None)
    for _ in range(2):
        r_ = zz - A@co; keep = np.abs(r_) < 2.5*max(np.std(r_), 1.0)
        if keep.sum() < 40: break
        co, *_ = np.linalg.lstsq(A[keep], zz[keep].astype(np.float64), rcond=None)
    oy, ox, oz = np.nonzero(m)[0], np.nonzero(m)[1], d[m]
    ok2 = ~np.isnan(oz)
    if ok2.sum() < 15: return None
    oy, ox, oz = oy[ok2], ox[ok2], oz[ok2]
    return float(np.percentile((co[0]*ox+co[1]*oy+co[2])-oz, 97))

def in_region(mk):
    ys, xs = np.nonzero(mk); cx, cy = xs.mean(), ys.mean()
    if _roi and not (_roi[0] <= cx <= _roi[2] and _roi[1] <= cy <= _roi[3]): return False
    return not any(x1 <= cx <= x2 and y1 <= cy <= y2 for x1,y1,x2,y2 in _ex)

def grab():
    """카메라 노드에서 새 컬러 프레임과 정렬된 깊이를 받는다."""
    seq = cam.get("cseq", 0)
    for _ in range(60):
        rclpy.spin_once(node, timeout_sec=0.1)
        if cam.get("cseq", 0) != seq: break
    bgr = cv2.cvtColor(cam["color"], cv2.COLOR_RGB2BGR)   # rs 토픽은 rgb8
    dep = cam["depth"].astype(np.float32).copy()          # uint16, mm
    dep[dep <= 0] = np.nan
    return bgr, dep


def detect_depth(bgr, depth):
    """깊이로 물체를 찾는다. 트레이 바닥보다 솟은 덩어리를 고른다.

    색·조명·프롬프트에 의존하지 않는 것이 장점이다 — 검은 물체도 잡힌다.
    바닥 깊이는 프레임마다 ROI 분위수로 다시 추정하므로 카메라 높이에 안 묶인다.

    트레이 테두리·격자 리브도 바닥보다 높아 같이 걸리므로 종횡비로 걸러낸다
    (09-11 실측: 물체 1.16 / 격자 리브 1.78 / 트레이 벽 3.06)."""
    H, W = depth.shape
    gray = cv2.createCLAHE(2.0, (8, 8)).apply(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)).astype(np.float32)
    roi = np.zeros((H, W), bool)
    if _roi:
        x1, y1, x2, y2 = (int(v) for v in _roi)
        roi[max(0,y1):min(H,y2), max(0,x1):min(W,x2)] = True
    else:
        roi[:] = True
    for x1, y1, x2, y2 in _ex:                       # 배제 영역
        roi[max(0,int(y1)):min(H,int(y2)), max(0,int(x1)):min(W,int(x2))] = False
    ok = roi & ~np.isnan(depth)
    if ok.sum() < 500:
        return []
    floor = float(np.percentile(depth[ok], a.depth_floor_pct))
    thr = floor - a.depth_bump_mm
    bump = (ok & (depth < thr)).astype(np.uint8) * 255
    bump = cv2.morphologyEx(bump, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    nl, lab, stats, cent = cv2.connectedComponentsWithStats(bump, 8)
    out = []
    for i in range(1, nl):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < a.min_area: continue
        if a.max_area > 0 and area > a.max_area: continue
        w, h = int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])
        if max(w, h) / max(1, min(w, h)) > a.depth_aspect_max: continue
        mk = (lab == i)
        dv = depth[mk]; dv = dv[~np.isnan(dv)]
        if dv.size < 5: continue
        Zc = float(np.median(dv))
        # 바닥 위 높이. 트레이 테두리·벽은 물체보다 훨씬 높이 솟는다.
        bump_mm = floor - Zc
        if a.depth_height_max > 0 and bump_mm > a.depth_height_max: continue
        aspect, taper, Lpx, Wpx = shape_feats(mk)
        Lmm = Lpx * Zc / FX if not np.isnan(Zc) else float("nan")
        if a.z_split_mm > 0:
            kind, by = ("탄피" if Zc < a.z_split_mm else "탄두"), "Z"
        elif not np.isnan(Lmm) and abs(Lmm - a.len_split_mm) >= 1.5:
            kind, by = ("탄피" if Lmm >= a.len_split_mm else "탄두"), "L"
        else:
            kind, by = ("탄피" if center_brightness(mk, gray) >= a.center_bright else "탄두"), "밝기"
        pose = "꽂힘" if aspect < a.pose_aspect else "누움"
        Z = float(np.percentile(dv, 10) if pose == "꽂힘" else np.median(dv))
        out.append(dict(kind=kind, pose=pose, u=float(cent[i][0]), v=float(cent[i][1]),
                        mask=mk, Z=Z, height=bump_mm, Lpx=Lpx, Wpx=Wpx, Lmm=Lmm,
                        area=area, by=by, src="깊이"))
    if out:
        print(f"  [깊이] 바닥 {floor:.0f}mm, 임계 {thr:.0f}mm → 후보 {nl-1}개 중 {len(out)}개 통과")
    return out


def kind_by_split_y(v, H):
    """화면 가로선으로 종류를 가른다. 선 아래(v 가 큰 쪽)가 카메라에 가까운 쪽 = 탄피.

    --split-y 0 이면 None 을 돌려주고 호출부가 기존 판정(Z·길이·밝기)을 쓴다."""
    if a.split_y == 0:
        return None, None
    sy = (H // 2) if a.split_y < 0 else a.split_y
    return ("탄피" if v > sy else "탄두"), sy


def detect_plane(bgr, depth):
    """scripts/run_sam3_depth.py 와 같은 파이프라인. 영상으로 검출이 잘 되는 것을 확인한 판이다.

    현재 기본 경로와 다른 점은 넷이다.
      1. 면적·길이 범위 필터를 쓰지 않는다 — 물체가 작게 보여도 버리지 않는다
      2. 기준면을 **물체마다 국소 평면**으로 잡고, 적합이 실패한 것만 배경 분위수로 폴백한다
         (화면 전체 분위수를 바닥으로 쓰면 트레이가 한 덩어리가 된다)
      3. 중복 제거·Z 분류·깊이 덩어리 검출을 쓰지 않는다
      4. 분류를 꽂힘/누움으로 먼저 가른 뒤 밝기·테이퍼로 종류를 정한다

    영상 판은 프롬프트 하나(bullet)에 임계 0.5 로 돌렸다. 그 조건을 쓰려면
      --detector plane --prompt bullet --threshold 0.5
    """
    gray = cv2.createCLAHE(2.0, (8, 8)).apply(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)).astype(np.float32)
    ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
    masks = []
    with torch.no_grad():
        ve = model.get_vision_features(pixel_values=ii.pixel_values)
        for q in prompts:
            o = model(vision_embeds=ve, **text_in[q])
            r = proc.post_process_instance_segmentation(
                o, threshold=a.threshold, mask_threshold=0.5,
                target_sizes=ii.get("original_sizes").tolist())[0]
            mm = r["masks"].detach().cpu().numpy().astype(bool)
            if mm.ndim == 4: mm = mm[:, 0]
            masks.extend(list(mm))

    # 배경 기준면 — 마스크가 아닌 화소의 분위수. 국소 평면 폴백으로만 쓴다.
    allmask = np.zeros(depth.shape, bool)
    for mk in masks: allmask |= mk
    bg = depth[~allmask & ~np.isnan(depth)]
    if a.plane_mm > 0:       plane = float(a.plane_mm)
    elif bg.size > 100:      plane = float(np.percentile(bg, a.plane_pct))
    else:                    plane = float(np.nanpercentile(depth, a.plane_pct))
    global _LAST_PLANE
    _LAST_PLANE = plane                # show() 가 머리말에 띄운다

    out, n_lp, n_bg = [], 0, 0
    for mk in masks:
        if a.min_area and mk.sum() < a.min_area: continue
        if a.max_area > 0 and mk.sum() > a.max_area: continue
        if not in_region(mk): continue

        dv = depth[mk]; dv = dv[~np.isnan(dv)]
        lp = local_plane_height(mk, depth, a.ring_px)
        if lp is not None:
            h_top = lp; n_lp += 1
        elif dv.size >= 20:
            h_top = float(np.percentile(plane - dv, 97)); n_bg += 1
        else:
            continue
        if not np.isnan(h_top) and h_top < a.min_height_mm: continue

        aspect, taper, Lpx, Wpx = shape_feats(mk)
        Zc = float(np.median(dv)) if dv.size >= 10 else float("nan")
        Lmm = Lpx * Zc / FX if not np.isnan(Zc) else float("nan")
        pose = "꽂힘" if aspect < a.pose_aspect else "누움"
        if a.standing_only and pose == "누움":
            continue                       # 누운 물체는 파지 보정값이 없다
        ys, xs = np.nonzero(mk)
        k_split, _sy = kind_by_split_y(float(ys.mean()), depth.shape[0])
        if k_split is not None:
            kind, by = k_split, f"가로선 y={_sy}"
        elif pose == "꽂힘":
            kind = "탄피" if center_brightness(mk, gray) >= a.center_bright else "탄두"
            by = "밝기"
        else:
            kind = "탄두" if taper >= a.taper_th else "탄피"
            by = "테이퍼"
        if dv.size >= 10:
            Z = float(np.percentile(dv, 10) if pose == "꽂힘" else np.median(dv))
        elif dv.size >= 3:
            Z = float(np.median(dv))
        else:
            Z = float("nan")
        out.append(dict(kind=kind, pose=pose, u=float(xs.mean()), v=float(ys.mean()),
                        mask=mk, Z=Z, height=h_top, Lpx=Lpx, Wpx=Wpx, Lmm=Lmm,
                        area=int(mk.sum()), by=by, src="평면"))
    print(f"  [평면] 기준면 {plane:.0f}mm · 마스크 {len(masks)}개 → {len(out)}개 "
          f"(국소평면 {n_lp} / 배경폴백 {n_bg})")
    return out


def detect(bgr, depth):
    if a.detector == "plane":
        return detect_plane(bgr, depth)
    if a.detector == "depth":
        return dedup(detect_depth(bgr, depth))
    gray = cv2.createCLAHE(2.0,(8,8)).apply(cv2.cvtColor(bgr,cv2.COLOR_BGR2GRAY)).astype(np.float32)
    ii = proc(images=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
    with torch.no_grad():
        ve = model.get_vision_features(pixel_values=ii.pixel_values)
        masks = []
        for q in prompts:
            o = model(vision_embeds=ve, **text_in[q])
            r = proc.post_process_instance_segmentation(o, threshold=a.threshold,
                    mask_threshold=0.5, target_sizes=ii.get("original_sizes").tolist())[0]
            mm = r["masks"].detach().cpu().numpy().astype(bool)
            if mm.ndim == 4: mm = mm[:,0]
            masks.extend(list(mm))
    out = []
    for mk in masks:
        if mk.sum() < a.min_area: continue
        if a.max_area > 0 and mk.sum() > a.max_area: continue
        if not in_region(mk): continue
        h = local_plane_height(mk, depth, a.ring_px)
        if h is not None and h < a.min_height_mm: continue

        ys, xs = np.nonzero(mk)
        dv = depth[mk]; dv = dv[~np.isnan(dv)]
        Zc = float(np.median(dv)) if dv.size >= 10 else float('nan')
        aspect, taper, Lpx, Wpx = shape_feats(mk)
        Lmm = Lpx * Zc / FX if not np.isnan(Zc) else float("nan")
        # 실물 크기 범위를 벗어나면 물체가 아니다(고정대 조인트·격자 조각)
        if not np.isnan(Lmm) and not (a.min_len_mm <= Lmm <= a.max_len_mm): continue

        _ys0, _xs0 = np.nonzero(mk)
        _ksp, _sy0 = kind_by_split_y(float(_ys0.mean()), depth.shape[0])
        if aspect < a.pose_aspect:
            pose = "꽂힘"
            # 화면 가로선이 1순위다 (09-12). 밝기·Z 판정보다 안정적이다 —
            # 밝기는 금속 반사에 흔들리고, Z 는 시작 높이를 바꾸면 경계를 다시 재야 한다.
            if _ksp is not None:
                kind, kind_by = _ksp, f"가로선 y={_sy0}"
            # 거리로 가르는 것이 그다음이다. 같은 평면에 꽂혀 있으면 긴 쪽(탄피)이
            # 카메라에 가깝다. 09-11 실측으로 17mm 이상 벌어져 길이(1.5mm 차)보다 안전하다.
            elif a.z_split_mm > 0 and not np.isnan(Zc) and Zc > 0:
                kind = "탄피" if Zc < a.z_split_mm else "탄두"
                kind_by = "Z"
            elif not np.isnan(Lmm) and abs(Lmm - a.len_split_mm) >= 1.5:
                kind = "탄피" if Lmm >= a.len_split_mm else "탄두"
                kind_by = "L"
            else:
                kind = "탄피" if center_brightness(mk, gray) >= a.center_bright else "탄두"
                kind_by = "밝기"
        else:
            pose = "누움"
            if a.standing_only:
                continue               # 누운 물체는 파지 보정값이 없다
            kind = _ksp if _ksp is not None else ("탄두" if taper >= a.taper_th else "탄피")
            kind_by = f"가로선 y={_sy0}" if _ksp is not None else "테이퍼"
        # 금속 반사·셀 그림자로 마스크 안 depth 가 대부분 뚫리는 경우가 잦다.
        # 표본이 적어도 있으면 쓰고, 아예 없을 때만 nan 으로 둔다.
        if dv.size >= 10:
            Z = float(np.percentile(dv, 10) if pose == "꽂힘" else np.median(dv))
        elif dv.size >= 3:
            Z = float(np.median(dv))
        else:
            Z = float("nan")
        out.append(dict(kind=kind, pose=pose, u=float(xs.mean()), v=float(ys.mean()),
                        mask=mk, Z=Z, height=h, Lpx=Lpx, Wpx=Wpx, Lmm=Lmm,
                        area=int(mk.sum()), by=kind_by))
    if a.detector == "both":
        dep_dets = detect_depth(bgr, depth)
        # 09-11 롤백: 매 프레임 합의로 되돌렸다. "첫 선정에만" 으로 바꾼 뒤
        # 탄두 인식이 나빠졌다 — 잘 되던 판(17:09)과 같게 맞춘다.
        if a.require_both:
            # 두 검출기가 같은 자리(--dedup-px 안)를 가리킨 것만 남긴다.
            # 위치는 SAM3 쪽을 쓴다 — 마스크가 물체에 맞아 중심이 더 정확하다.
            both = []
            for d in out:
                for e in dep_dets:
                    if ((d["u"]-e["u"])**2 + (d["v"]-e["v"])**2) ** 0.5 <= a.dedup_px:
                        both.append(dict(d, by=d.get("by", "?") + "+깊이",
                                         height=e.get("height")))
                        break
            print(f"  [합의] SAM3 {len(out)}개 · 깊이 {len(dep_dets)}개 → 합의 {len(both)}개")
            out = both
        else:
            out = out + dep_dets
    return dedup(out)


def dedup(dets):
    """같은 물체가 여러 번 잡힌 것을 하나로 합친다.

    프롬프트를 여러 개 쓰면 한 물체가 프롬프트마다 잡힌다. 게다가 마스크 범위가
    달라서(bullet 은 물체 전체, metal ring 은 링만) 길이가 다르게 측정되고
    분류까지 갈린다 — 09-11 에 같은 물체가 탄피와 탄두로 동시에 나왔다.

    중심이 --dedup-px 안이면 같은 물체로 보고 **면적이 큰 것**을 남긴다.
    면적이 큰 쪽이 물체 전체를 덮은 마스크이므로 길이 측정이 정상값에 가깝다."""
    if a.dedup_px <= 0 or len(dets) < 2:
        return dets
    kept = []
    for d in sorted(dets, key=lambda x: -x["area"]):      # 큰 것부터
        for k in kept:
            if ((d["u"]-k["u"])**2 + (d["v"]-k["v"])**2) ** 0.5 <= a.dedup_px:
                k.setdefault("merged", 0)
                k["merged"] += 1
                break
        else:
            kept.append(d)
    return kept

def pick_target(dets):
    """탄피 먼저, 그다음 탄두. 같은 종류면 로봇에 가까운 쪽.
    --kind 로 고정하면 그 종류만 후보로 본다 — 우선순위가 종류를 1차 키로 쓰므로
    분류가 한 번 뒤집히면 전혀 다른 물체가 1순위가 되는 걸 막는다."""
    if a.kind != "any":
        dets = [d for d in dets if d["kind"] == a.kind]
    if not dets: return None
    near = {"bottom": lambda d: -d["v"], "top": lambda d: d["v"],
            "left": lambda d: d["u"],   "right": lambda d: -d["u"]}[a.robot_side]
    return sorted(dets, key=lambda d: (0 if d["kind"]=="탄피" else 1, near(d)))[0]

_locked = {"uv": None, "kind": None, "lost_uv": None}   # 서보가 붙잡고 있는 대상


def track_target(dets):
    """한 번 고른 대상을 계속 따라간다.

    매 프레임 우선순위로 다시 고르면, 분류가 한 프레임 흔들리거나 순서가 바뀔 때
    다른 물체로 옮겨붙어 오차가 100px씩 튄다. 실제로 그 현상을 관측했다.
    그래서 처음 한 번만 우선순위로 고르고, 이후에는 직전 위치에 가장 가까운 검출을 잇는다."""
    if not dets:
        return None
    if _locked["uv"] is None:
        # 놓쳤다 다시 나타난 경우: 마지막으로 보던 자리에 가까운 것을 우선한다.
        # 우선순위로 새로 고르면 그 사이 순서가 바뀌어 다른 물체로 갈아타 버린다.
        if _locked["lost_uv"] is not None:
            lu, lv = _locked["lost_uv"]
            near = sorted((((d["u"]-lu)**2 + (d["v"]-lv)**2) ** 0.5, d) for d in dets)
            if near and near[0][0] <= a.regain_radius_px:
                t = near[0][1]
                _locked["uv"] = (t["u"], t["v"])
                _locked["kind"] = _locked["kind"] or t["kind"]
                _locked["lost_uv"] = None
                print(f"      (놓친 자리에서 {near[0][0]:.0f}px 떨어진 검출을 같은 물체로 이어감)")
                return dict(t, kind=_locked["kind"])
        t = pick_target(dets)
        if t is not None:
            _locked["uv"] = (t["u"], t["v"]); _locked["kind"] = t["kind"]
            _locked["lost_uv"] = None
        return t
    pu, pv = _locked["uv"]
    best, bd = None, 1e9
    for d in dets:
        dd = ((d["u"]-pu)**2 + (d["v"]-pv)**2) ** 0.5
        if dd < bd: best, bd = d, dd
    if best is None or bd > a.track_radius_px:
        _locked["lost_uv"] = _locked["uv"]      # 마지막 위치를 기억해 둔다
        _locked["uv"] = None
        return None                     # 반경 밖 = 놓친 것으로 본다
    _locked["uv"] = (best["u"], best["v"])
    if best["kind"] != _locked["kind"]:
        # 분류가 흔들려도 추적은 유지한다. 처음 판정을 신뢰한다.
        best = dict(best, kind=_locked["kind"])
    return best


_LAST_PLANE = None          # detect_plane 이 마지막으로 잡은 기준면. 머리말에 띄운다.

_KR_FONT = None
def _kr_font(size=15):
    """한글 폰트를 한 번만 연다. 없으면 None — 그 경우 호출부가 cv2 로 떨어진다."""
    global _KR_FONT
    if _KR_FONT is None:
        for p in ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
                  "/usr/share/fonts/truetype/nanum/NanumGothic.ttf"):
            if os.path.exists(p):
                try:
                    _KR_FONT = _PILFont.truetype(p, size); break
                except Exception:
                    pass
        if _KR_FONT is None: _KR_FONT = False
    return _KR_FONT or None


def draw_kr(img, items):
    """(x, y, 글자, BGR색) 목록을 그린다. cv2.putText 는 한글을 ??? 로 그려서 PIL 을 쓴다."""
    f = _kr_font()
    if f is None:                                   # 폰트가 없으면 영문만이라도 보이게
        for x, y, s, c in items:
            cv2.putText(img, s, (int(x), int(y)+14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, c, 2)
        return img
    pil = _PILImage.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    dr = _PILDraw.Draw(pil)
    for x, y, s, c in items:
        # 배경이 밝든 어둡든 읽히도록 검은 테두리를 깔고 그 위에 색을 얹는다.
        dr.text((int(x), int(y)), s, font=f, fill=(0, 0, 0), stroke_width=3,
                stroke_fill=(0, 0, 0))
        dr.text((int(x), int(y)), s, font=f, fill=(int(c[2]), int(c[1]), int(c[0])))
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def show(bgr, dets, tgt, note=""):
    """화면 표시. scripts/run_sam3_depth.py(영상판) 와 같은 것을 그린다.

    09-12: 분할 분류를 넣을 때 판정 로직만 옮기고 시각화가 빠져 있었다 —
    선이 어디 있는지 안 보이면 오분류를 눈으로 잡을 수 없다."""
    if not a.display: return
    COL = {("탄두","꽂힘"):(80,80,255), ("탄두","누움"):(255,180,80),
           ("탄피","꽂힘"):(80,255,120), ("탄피","누움"):(80,220,255)}
    vis = bgr.astype(np.float32)
    for d in dets:
        vis[d["mask"]] = vis[d["mask"]]*0.5 + np.array(COL[(d["kind"],d["pose"])],dtype=np.float32)*0.5
    vis = vis.clip(0,255).astype(np.uint8)
    H_, W_ = vis.shape[:2]

    # 검출마다 테두리 상자와 높이. 상자는 마스크에서 만든다.
    for d in dets:
        ys, xs = np.nonzero(d["mask"])
        if xs.size == 0: continue
        c = COL[(d["kind"], d["pose"])]
        x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
        cv2.rectangle(vis, (x0, y0), (x1, y1), c, 2)
        cv2.putText(vis, f"{d.get('height', float('nan')):.0f}mm", (x0, max(10, y0-4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, c, 1)

    # 종류 구분선. 아래가 카메라에 가까운 쪽 = 탄피, 위 = 탄두.
    PINK = (203, 92, 255)
    if a.split_y != 0:
        sy = (H_ // 2) if a.split_y < 0 else a.split_y
        cv2.line(vis, (0, sy), (W_, sy), PINK, 2)

    _t = a.tol_px if a.tol_px > 0 else (max(a.tol_min_px, 0.5*min(tgt.get("Wpx",0), tgt.get("Lpx",0)))
                                        if tgt else a.tol_min_px)
    cv2.circle(vis,(a.center_x,a.center_y),int(_t),(0,255,0),2)
    cv2.drawMarker(vis,(a.center_x,a.center_y),(0,255,0),cv2.MARKER_CROSS,18,1)
    if tgt is not None:
        cv2.drawMarker(vis,(int(tgt['u']),int(tgt['v'])),(0,255,255),cv2.MARKER_TILTED_CROSS,22,2)
        cv2.arrowedLine(vis,(int(tgt['u']),int(tgt['v'])),(a.center_x,a.center_y),(0,255,255),1,tipLength=.15)

    # 한글은 cv2.putText 가 못 그린다 (??? 로 나온다) — 글자만 PIL 로 올린다.
    txts = []
    _pl = f"{_LAST_PLANE:.0f}mm" if _LAST_PLANE is not None else "-"
    txts.append((8, 6, f"기준면 {_pl}   검출 {len(dets)}개", (0,255,255)))
    cnt = {}
    for d in dets:
        k = f"{d['kind']}({d['pose']})"
        cnt[k] = cnt.get(k, 0) + 1
    for i, (k, v) in enumerate(sorted(cnt.items())):
        kk, pp = k[:2], k[3:-1]
        txts.append((8, 26 + i*20, f"{k}: {v}", COL[(kk, pp)]))
    if a.split_y != 0:
        sy = (H_ // 2) if a.split_y < 0 else a.split_y
        txts.append((W_-150, sy-24, "탄두 (먼 쪽)", PINK))
        txts.append((W_-150, sy+6,  "탄피 (가까운 쪽)", PINK))
    if tgt is not None:
        du, dv_ = tgt['u']-a.center_x, tgt['v']-a.center_y
        err = (du*du + dv_*dv_) ** 0.5
        inside = err <= _t
        col = (0,255,0) if inside else (0,200,255)
        Z_ = tgt.get("Z", float("nan"))
        if Z_ == Z_ and FX:      # NaN 이 아니고 초점거리를 읽었으면 mm 로도 보여준다
            s = f"{err:.1f}px ({du*Z_/FX:+.1f},{dv_*Z_/FY:+.1f})mm"
        else:
            s = f"{err:.1f}px (Z 없음)"
        txts.append((int(tgt['u'])+14, int(tgt['v'])-24, s + ("  OK" if inside else ""), col))
    if note:
        txts.append((8, H_-24, note, (0,255,255)))
    vis = draw_kr(vis, txts)
    cv2.imshow("SAM3 pick (ROS2)", vis); cv2.waitKey(1)

# ---------------------------- 로봇부 ----------------------------
rclpy.init()
node = Node("sam3_pick_ros2")
state = {}
node.create_subscription(RobotNonrtState, "/nonrt_state_data",
                         lambda m: state.__setitem__("s", m), 1)

cam = {}
node.create_subscription(Image, TOPIC_COLOR,
    lambda m: cam.update(color=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3),
                         cseq=cam.get("cseq", 0) + 1), 1)
node.create_subscription(Image, TOPIC_DEPTH,
    lambda m: cam.update(depth=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width)), 1)
node.create_subscription(CameraInfo, TOPIC_INFO,
    lambda m: cam.update(K=np.array(m.k).reshape(3, 3)), 1)

# --save-grip-offset 은 로봇 좌표만 읽으므로 카메라가 필요 없다.
if a.save_grip_offset or a.no_servo:
    print("[save] 카메라 없이 로봇 좌표만 읽습니다")
    FX = FY = 1.0
else:
    print("카메라 토픽을 기다립니다…")
    for _ in range(150):
        rclpy.spin_once(node, timeout_sec=0.1)
        if all(k in cam for k in ("color", "depth", "K")): break
    _missing = [k for k in ("color", "depth", "K") if k not in cam]
    if _missing:
        raise SystemExit(
            f"카메라 토픽 수신 실패: {_missing}\n"
            f"  {TOPIC_COLOR}\n  {TOPIC_DEPTH}\n"
            "  ros2 launch realsense2_camera rs_launch.py align_depth.enable:=true")
    FX = float(cam["K"][0, 0])
    FY = float(cam["K"][1, 1])
    print(f"[cam ] {cam['color'].shape[1]}x{cam['color'].shape[0]} color / "
          f"{cam['depth'].shape[1]}x{cam['depth'].shape[0]} aligned depth  fx={FX:.1f}")
    if not a.center_x_set: a.center_x = cam['color'].shape[1] // 2
    if not a.center_y_set: a.center_y = cam['color'].shape[0] // 2
    print(f"[center] 화면 중심 ({a.center_x}, {a.center_y})")
cli = node.create_client(RemoteCmdInterface, "/fairino_remote_command_service")

def spin(sec=0.1): rclpy.spin_once(node, timeout_sec=sec)


# 관절 궤적 기록 — 유니티에서 실기 동작을 재생하기 위한 것.
# 별도 스레드에서 마지막으로 받은 상태를 주기적으로 찍는다. state["s"] 는 메인 스레드의
# spin() 이 갱신하므로, 이동 중에는 settle() 이 계속 spin 하기 때문에 값이 살아 있다.
GRIPPER_TRAVEL_M = 0.021          # 손가락 전체 행정. 기존 traj_ep000.json 과 같은 값
JOINT_NAMES = ["j1", "j2", "j3", "j4", "j5", "j6"]

# 상태 메시지에는 그리퍼 **위치** 필드가 없다 (grip_motion_done / 고장 / 에러뿐).
# 그래서 명령한 값을 여기에 남긴다 — 재생에는 명령값이 맞다.
_grip_cmd = [float(GRIPPER_START)]


class TrajRecorder:
    def __init__(self, path, fps):
        self.path, self.fps = path, max(1.0, float(fps))
        self.deg, self.finger, self.tcp = [], [], []
        self._stop = threading.Event()
        self._th = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        if self.path: self._th.start()
        return self

    def _loop(self):
        dt = 1.0 / self.fps
        while not self._stop.wait(dt):
            s_ = state.get("s")
            if s_ is None: continue
            self.deg.append([round(float(v), 4) for v in
                             (s_.j1_cur_pos, s_.j2_cur_pos, s_.j3_cur_pos,
                              s_.j4_cur_pos, s_.j5_cur_pos, s_.j6_cur_pos)])
            self.finger.append(round(_grip_cmd[0] / 100.0 * GRIPPER_TRAVEL_M, 6))
            self.tcp.append([round(float(s_.cart_x_cur_pos), 3),
                             round(float(s_.cart_y_cur_pos), 3),
                             round(float(s_.cart_z_cur_pos), 3)])

    def save(self):
        if not self.path: return
        self._stop.set()
        self._th.join(timeout=2.0)
        if not self.deg:
            print(f"\n[궤적] 표본이 없어 저장하지 않습니다 ({self.path})")
            return
        out = {
            "episode": 0,
            "fps": int(round(self.fps)),
            "frames": len(self.deg),
            "task": "SAM3 로 물체를 찾아 격자 트레이에서 꺼내 고정대에 꽂는다",
            "joint_names": JOINT_NAMES,
            "gripper_index": 6,
            "checkpoint": "실기 기록 (정책 추론 아님)",
            "gripper_travel_m": GRIPPER_TRAVEL_M,
            # 유니티 TrajectoryPlayer 는 predicted_* 를 읽는다. 실기 기록을 거기에 넣고,
            # reference_* 에도 같은 값을 넣어 비교 화면이 비지 않게 한다.
            "predicted_deg": self.deg,
            "reference_deg": self.deg,
            "state_deg": self.deg,
            "predicted_finger_m": self.finger,
            "reference_finger_m": self.finger,
            "predicted_gripper": self.finger,
            "reference_gripper": self.finger,
            "tcp_mm": self.tcp,
            "error_deg": {"mean": 0.0, "median": 0.0, "max": 0.0},
        }
        pth = pathlib.Path(self.path).expanduser()
        pth.parent.mkdir(parents=True, exist_ok=True)
        pth.write_text(json.dumps(out, ensure_ascii=False))
        secs = len(self.deg) / self.fps
        print(f"\n[궤적] {pth}  {len(self.deg)}프레임 / {secs:.1f}초 @ {self.fps:.0f}fps")
        print(f"       유니티: StreamingAssets/ 에 넣고 TrajectoryPlayer 로 재생")



def cur_rpy(timeout=5.0):
    """현재 TCP 자세(rx,ry,rz). --rpy 로 고정하지 않으면 이 값을 그대로 쓴다."""
    if a.rpy: return tuple(float(v) for v in a.rpy.split(","))
    t = time.time()
    while time.time()-t < timeout:
        spin()
        if "s" in state:
            s_ = state["s"]
            return (s_.cart_a_cur_pos, s_.cart_b_cur_pos, s_.cart_c_cur_pos)
    raise TimeoutError("자세를 읽지 못했습니다(/nonrt_state_data)")


def cur_pose(timeout=5.0):
    """현재 TCP 좌표. 미리보기에서도 실제 값을 읽는다(읽기는 로봇을 움직이지 않는다)."""
    t = time.time()
    while time.time()-t < timeout:
        spin()
        if "s" in state:
            s = state["s"]
            return np.array([s.cart_x_cur_pos, s.cart_y_cur_pos, s.cart_z_cur_pos])
    raise TimeoutError("로봇 상태(/nonrt_state_data)를 못 받았습니다. ros2_cmd_server 확인")

def send(cmd, timeout=20.0, force=False):
    """force=True 는 --move 없이도 실제로 보낸다.
    시작 위치 이동과 상태 조회가 여기에 해당한다 — 거기까지 안 가면
    카메라가 작업대를 안 봐서 검출 확인 자체가 안 된다."""
    if a.dry or not (DO_MOVE or force):
        print(f"    [dry-run] {cmd}")
        return "dry-run"
    req = RemoteCmdInterface.Request(); req.cmd_str = cmd
    fut = cli.call_async(req)
    rclpy.spin_until_future_complete(node, fut, timeout_sec=timeout)
    if fut.result() is None: raise TimeoutError(f"응답 시간 초과: {cmd}")
    return fut.result().cmd_res

from rcl_interfaces.srv import SetParameters
from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType

_param_cli = None
def set_offset(dx, dy, dz):
    """MoveL 의 offset_pos 파라미터를 세팅한다.
    로봇이 현재 위치를 기준으로 이만큼 상대 이동한다(트랜스).
    내가 절대좌표를 계산해 넣는 방식과 달리, 기준 좌표계 변환을 로봇이 처리한다."""
    global _param_cli
    if _param_cli is None:
        _param_cli = node.create_client(SetParameters, "/fr_command_server/set_parameters")
        if not _param_cli.wait_for_service(timeout_sec=5.0):
            raise RuntimeError("/fr_command_server/set_parameters 에 연결할 수 없습니다")
    req = SetParameters.Request()
    for nm, val in (("MoveJLC_offset_flag", a.offset_frame),
                    ("MoveJLC_offset_pos_x", dx), ("MoveJLC_offset_pos_y", dy),
                    ("MoveJLC_offset_pos_z", dz),
                    ("MoveJLC_offset_pos_rx", 0.0), ("MoveJLC_offset_pos_ry", 0.0),
                    ("MoveJLC_offset_pos_rz", 0.0)):
        pv = (ParameterValue(type=ParameterType.PARAMETER_INTEGER, integer_value=int(val))
              if nm.endswith("flag") else
              ParameterValue(type=ParameterType.PARAMETER_DOUBLE, double_value=float(val)))
        req.parameters.append(Parameter(name=nm, value=pv))
    fut = _param_cli.call_async(req)
    rclpy.spin_until_future_complete(node, fut, timeout_sec=5.0)
    if fut.result() is None: raise TimeoutError("offset 파라미터 설정 실패")


# MoveL 실측 이송 속도 — 5% 에서 약 2.4mm/s. 속도에 대략 비례한다.
MM_PER_S_AT_1PCT = 0.48


def wrap180(x):
    """각도를 ±180 으로 감는다. -158.6 과 179.8 의 차이는 338도가 아니라 21.6도다."""
    return (float(x) + 180.0) % 360.0 - 180.0


def settle(tgt_xyz, tol, timeout, still=0.05, need=3, tick=0.05,
           rpy_tgt=None, rpy_tol=0.3):
    """목표 tol 안에 들어오고 **움직임이 멈출 때까지** 기다린다.

    거리 판정만 쓰면 감속 구간에서 조기 통과한다 — 09-11 실측: 하강 목표차가
    매번 +1.73 ~ +1.90mm 로 tol 2.0mm 바로 아래였고, 아직 내려오는 중에
    그리퍼를 닫아 꽂힌 탄두를 세 번 놓쳤다. 물릴 구간이 2~3mm 뿐이라
    1.8mm 부족만으로 헛닫힘이 된다.

    그래서 (a) 목표까지 tol 안 (b) 직전 관측 대비 still mm 미만 이동이
    need 회 연속 — 두 조건을 모두 본다. 반환값은 (도달여부, 최종좌표)."""
    t0 = time.time(); prev = None; prev_r = None; quiet = 0
    while time.time() - t0 < timeout:
        spin()
        cur = cur_pose()
        r = cur_rpy() if rpy_tgt is not None else None
        moved = float(np.linalg.norm(cur - prev)) if prev is not None else 1e9
        turned = (max(abs(wrap180(r[i] - prev_r[i])) for i in range(3))
                  if (r is not None and prev_r is not None) else 0.0)
        # 순수 회전은 XYZ 가 이미 목표라 거리만 보면 즉시 통과한다.
        # 그래서 "멈춤" 판정에 자세 변화도 넣는다 (09-12: 회전이 시작도 전에 완료로 처리됐다).
        if moved < still and turned < 0.05:
            quiet += 1
        else:
            quiet = 0
        prev, prev_r = cur, r
        if quiet >= need and float(np.linalg.norm(cur - np.asarray(tgt_xyz, float))) < tol:
            if rpy_tgt is None:
                return True, cur
            dr = max(abs(wrap180(r[i] - float(rpy_tgt[i]))) for i in range(3))
            if dr < rpy_tol:
                return True, cur
        time.sleep(tick)
    return False, cur_pose()


def move_rel(dx, dy, dz=0.0, wait=True, tol=2.0, timeout=None, speed=None):
    """현재 위치에서 (dx,dy,dz) mm 만큼 상대 이동한다.
    CARTPoint 에는 현재 자세를 그대로 넣고, 이동량은 offset 파라미터로 준다.

    타임아웃은 이동 거리에 비례해서 잡는다. 고정 60초로 두면 5% 속도에서
    194mm 하강이 146mm 지점에서 걸린다 — 로봇은 정상 이동 중인데 코드가 포기한다."""
    dist = float(np.linalg.norm([dx, dy, dz]))
    sp = a.speed if speed is None else speed
    if timeout is None:
        est = dist / max(MM_PER_S_AT_1PCT * sp, 0.1)        # 예상 소요
        timeout = max(20.0, est * 3.0)                      # 여유 3배
    p0 = cur_pose(); rx, ry, rz = cur_rpy()
    set_offset(dx, dy, dz)
    r1 = send(f"CARTPoint(1,{p0[0]:.3f},{p0[1]:.3f},{p0[2]:.3f},{rx:.3f},{ry:.3f},{rz:.3f})")
    if str(r1).strip() not in ("0", "dry-run"):
        print(f"    ✗ CARTPoint 거부 (코드 {r1})"); return False
    r2 = send(f"{a.movecmd}(CART1,{sp},{TOOL},{USER})")
    if str(r2).strip() not in ("0", "dry-run"):
        print(f"    ✗ {a.movecmd} 거부 (코드 {r2})  — 로봇이 명령을 받지 않았습니다")
        return False
    if a.dry: return True              # 로봇이 안 움직이니 도달 대기는 무의미하다
    if not (wait and DO_MOVE): return True
    tgt_xyz = p0 + np.array([dx, dy, dz])
    okd, cur = settle(tgt_xyz, tol, timeout)
    if okd: return True
    moved = np.linalg.norm(cur_pose() - p0)
    print(f"    ✗ {timeout:.0f}초 내 도달 못함 (실제 이동 {moved:.2f}mm / 명령 {dist:.2f}mm, "
          f"속도 {sp}% 예상 {dist/max(MM_PER_S_AT_1PCT*sp,0.1):.0f}초)")
    return False


# grip_motion_done 관측값 — 개방(35) 후 1, 물체를 물고 정지했을 때 2.
# 표본 1회뿐이라 판정 실패로 다루지 않고 경고만 한다.
GRIP_DONE_POSITION = 1      # 지정 위치까지 갔다
GRIP_DONE_HOLDING  = 2      # 물체에 걸려 멈췄다 = 잡힘


def gripper(pos, force=False, timeout=20.0, expect_hold=False):
    """그리퍼를 pos 로 움직인다. 작을수록 닫힌다. 끝난 뒤 grip_motion_done 을 돌려준다.

    grip_motion_done 은 움직이는 동안 0, 끝나면 1 또는 2 다 (실측: 개방 1 / 파지 2).
    활성화 직후에는 캘리브레이션 때문에 5초를 넘긴다 (실측: 개방 12.7초, 파지 14.8초).
    명령 직후의 값은 직전 동작의 잔상일 수 있어 0 을 한 번 본 뒤부터 완료로 인정한다.

    expect_hold=True 면 물체를 잡는 동작이라는 뜻이다. 2 가 아니면 빈손 가능성을
    경고한다 — 안 잡혔는데 잡은 줄 알고 다음 단계로 가는 걸 막는다."""
    _grip_cmd[0] = float(pos)          # 궤적 기록용. 실제 명령과 같이 움직인다
    send(f"MoveGripper({GRIPPER_ID},{pos},{GRIPPER_SPEED},{GRIPPER_TORQUE},"
         f"{GRIPPER_MAXTIME},0,0,0,0,0)", force=force)
    if not (DO_MOVE or force): return None
    t = time.time(); saw_moving = False
    while time.time()-t < timeout:
        spin()
        s_ = state.get("s")
        if s_ is None: continue
        if s_.grippererro or s_.gripperfaultnum:
            print(f"    ✗ 그리퍼 오류 (erro={s_.grippererro} fault={s_.gripperfaultnum})")
            return None
        done = s_.grip_motion_done
        if done == 0:
            saw_moving = True
        elif saw_moving:
            _what = {GRIP_DONE_POSITION: "위치 도달", GRIP_DONE_HOLDING: "물체에 걸려 정지"}
            print(f"    그리퍼 {pos} 완료 ({time.time()-t:.1f}초, "
                  f"done={done} {_what.get(done, '?')})")
            if expect_hold and done != GRIP_DONE_HOLDING:
                print(f"    ⚠️ 잡는 동작인데 done={done} 입니다 — 빈손일 수 있습니다. "
                      "물체가 물렸는지 확인하세요")
            return done
    s_ = state.get("s")
    _f = getattr(s_, "grip_motion_done", "?") if s_ else "?"
    print(f"    (경고: {timeout:.0f}초 내 그리퍼 완료 신호 못 받음 — "
          f"grip_motion_done={_f}, 움직임 감지={saw_moving})")
    return None


def lift(mm=None):
    """파지 후 상대좌표로 들어올린다. 절대 좌표를 계산하지 않으므로
    어느 위치에서 잡았든 그만큼만 올라간다.

    mm 을 주면(종류별 KIND_CFG 의 "lift") 그 값을, 없으면 --lift-mm 을 쓴다."""
    mm = a.lift_mm if mm is None else float(mm)
    if mm <= 0:
        print("\n[들어올리기] 0 이라 올리지 않습니다")
        return True
    p0 = cur_pose()
    print(f"\n[들어올리기] 상대 이동 (0, 0, {mm:+.1f}) mm")
    if not move_rel(0.0, 0.0, mm, speed=a.speed_move):
        print("  ✗ 들어올리기 실패 — 물체를 잡은 채로 멈췄습니다")
        return False
    p1 = cur_pose()
    print(f"[들어올리기 완료] TCP = ({p1[0]:.2f}, {p1[1]:.2f}, {p1[2]:.2f})  "
          f"실제 상승 {p1[2]-p0[2]:+.2f}mm")
    return True


def move_abs(pose, label, tol=3.0, timeout=None, speed=None, check_rpy=False):
    """절대 카테시안 좌표로 이동한다. pose = (x, y, z, rx, ry, rz).

    서보용 offset 이 남아 있으면 목표에 더해지므로 먼저 0 으로 되돌린다.
    타임아웃은 남은 거리에 비례해서 잡는다."""
    x, y, z, rx, ry, rz = pose
    p0 = cur_pose()
    dist = float(np.linalg.norm(np.array([x, y, z]) - p0))
    sp = a.speed_move if speed is None else speed
    if timeout is None:
        timeout = max(20.0, dist / max(MM_PER_S_AT_1PCT * sp, 0.1) * 3.0)
    print(f"\n[{label}] 절대 이동 → ({x:.2f}, {y:.2f}, {z:.2f})  "
          f"자세 ({rx:.2f}, {ry:.2f}, {rz:.2f})")
    print(f"       현재 ({p0[0]:.2f}, {p0[1]:.2f}, {p0[2]:.2f})  거리 {dist:.1f}mm")
    set_offset(0.0, 0.0, 0.0)          # 서보 offset 이 목표에 더해지지 않게
    r1 = send(f"CARTPoint(1,{x:.3f},{y:.3f},{z:.3f},{rx:.3f},{ry:.3f},{rz:.3f})", force=True)
    if str(r1).strip() not in ("0", "dry-run"):
        print(f"    ✗ CARTPoint 거부 (코드 {r1})"); return False
    r2 = send(f"{a.movecmd}(CART1,{sp},{TOOL},{USER})", force=True)
    if str(r2).strip() not in ("0", "dry-run"):
        print(f"    ✗ {a.movecmd} 거부 (코드 {r2})"); return False
    if a.dry: return True
    okd, cur = settle([x, y, z], tol, timeout,
                      rpy_tgt=(rx, ry, rz) if check_rpy else None)
    if okd:
        print(f"[{label} 완료] TCP = ({cur[0]:.2f}, {cur[1]:.2f}, {cur[2]:.2f})  "
              f"차이 ({cur[0]-x:+.2f}, {cur[1]-y:+.2f}, {cur[2]-z:+.2f}) mm")
        return True
    print(f"    ✗ {timeout:.0f}초 내 도달 못함 — 현재 "
          f"({cur[0]:.2f}, {cur[1]:.2f}, {cur[2]:.2f}), 남은 거리 "
          f"{np.linalg.norm(cur-np.array([x,y,z])):.2f}mm")
    return False


def move_joints(joints, label):
    """관절값(도)으로 절대 이동한다.

    카테시안(MoveCart/MoveL)은 역기구학을 풀어야 해서 특이점·리치 한계에서
    거부된다. 관절값은 그 각도로 바로 가므로 정해진 자세에는 이쪽이 안전하다."""
    print(f"\n[{label}] 관절 = [" + ", ".join(f"{v:.3f}" for v in joints) + "]")
    set_offset(0.0, 0.0, 0.0)          # 서보용 offset 이 남아 있지 않게
    r1 = send("JNTPoint(1," + ",".join(f"{v:.3f}" for v in joints) + ")", force=True)
    if str(r1).strip() not in ("0", "dry-run"):
        print(f"    ✗ JNTPoint 거부 (코드 {r1})"); return False
    r2 = send(f"MoveJ(JNT1,{a.speed},{TOOL},{USER})", force=True)
    if str(r2).strip() not in ("0", "dry-run"):
        print(f"    ✗ MoveJ 거부 (코드 {r2})"); return False
    t = time.time()
    while time.time()-t < 90.0:
        spin()
        r = send("GetActualJointPosDegree(0)", force=True)
        try:
            cur = [float(v) for v in str(r).split(",")][1:7]
        except Exception:
            time.sleep(0.2); continue
        if max(abs(c-t_) for c, t_ in zip(cur, joints)) < 0.5: return True
        time.sleep(0.2)
    print(f"    ✗ 90초 내 {label} 관절값 도달 못함")
    return False



def rotate_to(rpy_abs, label="파지 자세로 회전"):
    """제자리에서 자세만 절대값으로 바꾼다. 병진은 하지 않는다.

    왜 절대값인가 — 지금 rx 는 -158.6, 검증 자세는 179.77 로 **둘 다 ±180 경계
    근처**다. 오일러 각에 델타를 더하면 뒤집힌다. 그래서 목표 자세를 그대로 준다.

    왜 회전을 먼저 하나 — 격자 칸 안에서 회전하면 그리퍼가 물체를 쓸어버린다.
    높은 데서 자세를 잡고 수직으로 내려가야 꽂힌 물체가 안 밀린다."""
    p0 = cur_pose(); r0 = cur_rpy()
    # 각도 차이는 ±180 으로 감아서 재야 한다. 그냥 빼면 -158.6 과 179.8 의 차이가
    # 338도로 나오지만 실제 회전량은 21.6도다.
    def _wrap(x):
        return (float(x) + 180.0) % 360.0 - 180.0
    d = max(abs(_wrap(float(rpy_abs[i]) - float(r0[i]))) for i in range(3))
    if d < 0.2:
        print(f"\n[{label}] 이미 목표 자세입니다 (차이 {d:.2f}도) — 건너뜁니다")
        return True
    print(f"\n[{label}] ({r0[0]:.2f}, {r0[1]:.2f}, {r0[2]:.2f}) → "
          f"({rpy_abs[0]:.2f}, {rpy_abs[1]:.2f}, {rpy_abs[2]:.2f})   최대 {d:.2f}도")
    print("       제자리 회전입니다. 그리퍼가 도는 범위에 물체가 없어야 합니다.")
    tgt = [p0[0], p0[1], p0[2], float(rpy_abs[0]), float(rpy_abs[1]), float(rpy_abs[2])]
    # check_rpy=True 가 핵심이다. 순수 회전은 XYZ 가 이미 목표라, 거리만 보면
    # 회전이 시작도 전에 "도달" 로 처리된다. 그러면 다음 명령이 회전 중의 자세를
    # cur_rpy() 로 읽어 그 자세로 되돌려버린다 (09-12 실측).
    if not move_abs(tgt, label, tol=1.0, speed=a.speed_move, check_rpy=True):
        return False
    r1 = cur_rpy()
    d1 = max(abs(_wrap(float(rpy_abs[i]) - float(r1[i]))) for i in range(3))
    print(f"[{label} 완료] 자세 = ({r1[0]:.3f}, {r1[1]:.3f}, {r1[2]:.3f})  "
          f"목표와 {d1:.3f}도")
    if d1 > 0.5:
        print(f"    ✗ 자세가 목표에 도달하지 않았습니다 ({d1:.2f}도) — 중단합니다")
        return False
    return True


def grip_dz_compensated(gz):
    """실측 때와 시작 Z 가 다를 때만 그 **차이**를 보상한다.

    보정값은 정렬 자세에서 파지 지점까지의 상대 이동이고, 정렬은 X/Y 만 움직이므로
    정렬 Z = 시작 Z 다. 그래서 같은 시작 높이에서 재고 쓰면 보상은 0 이다.

    09-12 에 이걸 틀려 사고가 날 뻔했다 — +82mm 올린 상태에서 실측한 dz(-388)에
    다시 82 를 빼서 -470 이 됐다. 테이블을 뚫는 값이다. 그래서 실측 당시의 상승분을
    grip_offset.json 에 함께 저장하고 차이만 본다."""
    if a.no_servo:
        return gz
    base = GRIP_LIFT_MM                      # 실측 당시의 시작 Z 상승분
    if base is None:
        if abs(a.home_lift_mm) > 0.01:
            print(f"       ⚠️ 보정값에 실측 시 시작 높이가 없습니다. 지금 "
                  f"{a.home_lift_mm:+.1f}mm 올린 상태라 하강이 그만큼 부족할 수 "
                  f"있습니다 — --save-grip-offset 으로 다시 재는 것이 안전합니다.")
        return gz
    d = a.home_lift_mm - base
    if abs(d) < 0.01:
        return gz
    out = gz - d
    print(f"       [보상] 실측 시 상승 {base:+.1f}mm, 지금 {a.home_lift_mm:+.1f}mm "
          f"→ 차이 {d:+.1f}mm, 하강 dz {gz:+.2f} → {out:+.2f} mm")
    return out


def move_home():
    """관절로 시작 위치에 간 뒤, --home-lift-mm 만큼 Z 를 더 올린다.

    시작 위치는 하드코딩된 관절값이다 (09-10 결정). Z 를 올리는 것은 관절을 다시 잡는
    대신 도달 후 상대 이동으로 처리한다 — 역기구학이 필요 없고, 값을 0 으로 두면
    검증된 기존 동작과 완전히 같다."""
    if not move_joints(HOME_JOINTS, "시작 위치로 이동"):
        return False
    if abs(a.home_lift_mm) < 0.01:
        return True
    print(f"\n[시작 위치] Z 를 {a.home_lift_mm:+.1f}mm 올립니다 (--home-lift-mm)")
    if not move_rel(0.0, 0.0, a.home_lift_mm, speed=a.speed_move):
        print("  ✗ 시작 위치 상승 실패")
        return False
    _p = cur_pose()
    print(f"[시작 위치] TCP = ({_p[0]:.2f}, {_p[1]:.2f}, {_p[2]:.2f})")
    return True


def place_h_correct(cfg, tgt):
    """정렬된 상태의 높이 h 로 놓기 Y 를 옮긴다. 상수로 박지 않는다.

    물체가 멀리 있으면 화면의 h 가 작게 나오고, 그만큼 파지가 어긋나 놓을 때 Y 가
    모자란다. 기준 h 와의 차이만큼 **놓을 위치만** 옮긴다. 경유점은 실측값 그대로 둔다.

    09-12 8차: 경유점까지 같이 옮기게 짰더니 h 가 82.9mm 로 튀었을 때 경유점이
    +72mm 날아가 로봇이 엉뚱한 곳으로 갔다. 경유점은 검증된 안전 경로라 건드리지 않는다.

    2026-09-12 5차: 정렬 h 8.4mm 에서 Y -1149.665 가 3mm 모자랐다 → 기준 h 11.4mm."""
    if a.place_h_ref is None:
        return cfg
    h = tgt.get("height") if tgt else None
    if not isinstance(h, (int, float)) or np.isnan(h):
        print("\n[놓기 보정] 정렬 시점 h 가 없어 보정하지 않습니다")
        return cfg
    raw = a.place_h_k * (float(h) - a.place_h_ref)
    lim = abs(a.place_h_max_mm)
    dy = max(-lim, min(lim, raw))                     # 최대 ±lim mm 로 자른다
    if dy != raw:
        print(f"\n[놓기 보정] 계산값 {raw:+.2f}mm 가 한계 ±{lim:g}mm 를 넘어 {dy:+.2f}mm 로 자릅니다")
    out = dict(cfg)
    if out.get("pose") is not None:                  # 경유점(approach)은 그대로 둔다
        p = list(out["pose"]); p[1] = float(p[1]) + dy; out["pose"] = p
    print(f"\n[놓기 보정] 정렬 h {h:.1f}mm − 기준 {a.place_h_ref:.1f}mm = {h - a.place_h_ref:+.1f}"
          f"  × {a.place_h_k:g}  →  Y {dy:+.2f}mm")
    if out.get("pose") is not None:
        print(f"            놓을 위치 Y {cfg['pose'][1]:.3f} → {out['pose'][1]:.3f}")
    return out


def move_place(kind, cfg):
    """종류별 경유점으로 간 뒤 수직으로 내려가 놓는다. 좌표가 없으면 건너뛴다."""
    approach, pose, press = cfg.get("approach"), cfg.get("pose"), cfg.get("press") or []
    if approach is None or pose is None:
        print(f"\n[놓기] '{kind}' 의 놓기 좌표가 비어 있어 건너뜁니다.")
        print(f"       물체를 든 채로 멈춥니다 — Jog 으로 잡아 KIND_CFG['{kind}'] 의")
        print("       approach / pose 에 넣으세요 (또는 --place-approach / --place-pose).")
        _p = cur_pose(); _r = cur_rpy()
        print(f"       현재 TCP  = ({_p[0]:.3f}, {_p[1]:.3f}, {_p[2]:.3f})")
        print(f"       현재 자세 = ({_r[0]:.3f}, {_r[1]:.3f}, {_r[2]:.3f})")
        return True

    if not move_abs(approach, f"[{kind}] 경유점으로 이동"):
        print("  ✗ 접근 지점 이동 실패 — 물체를 잡은 채로 멈췄습니다")
        return False
    if not move_abs(pose, f"[{kind}] 놓을 위치로 하강"):
        print("  ✗ 놓을 위치로 하강 실패 — 물체를 잡은 채로 멈췄습니다")
        return False
    for i, dz in enumerate(press, 1):
        tgt_pose = pose[:2] + [pose[2] + dz] + pose[3:]
        if not move_abs(tgt_pose, f"[{kind}] 박기 {i}/{len(press)} ({dz:+.1f}mm)", tol=1.0):
            print(f"  ✗ 박기 {i}단계 실패 — 이 깊이에서 걸렸습니다 (Z={tgt_pose[2]:.2f})")
            return False
    # 박기 마지막 좌표에서 이어서 가는 단계. 절대 좌표로 만들어 tol 을 조인다.
    after = cfg.get("after") or []
    base = pose[:2] + [pose[2] + (press[-1] if press else 0.0)] + pose[3:]
    for i, (dx, dy, dz) in enumerate(after, 1):
        base = [base[0] + dx, base[1] + dy, base[2] + dz] + base[3:]
        if not move_abs(base, f"[{kind}] 마무리 {i}/{len(after)} "
                              f"({dx:+.1f}, {dy:+.1f}, {dz:+.1f})mm", tol=1.0):
            print(f"  ✗ 마무리 {i}단계 실패 — 물체를 잡은 채로 멈췄습니다")
            return False
    if cfg.get("release", True):
        print(f"\n[그리퍼] {GRIPPER_START} 로 벌려 놓습니다")
        gripper(GRIPPER_START, force=True)
    else:
        print(f"\n[{kind}] 파지를 풀지 않습니다 "
              f"(KIND_CFG['{kind}']['release'] = False)")

    if not cfg.get("back", True):
        _p = cur_pose()
        print(f"\n[{kind}] 복귀하지 않고 놓은 자리에서 멈춥니다 "
              f"(KIND_CFG['{kind}']['back'] = False)")
        print(f"       현재 TCP = ({_p[0]:.3f}, {_p[1]:.3f}, {_p[2]:.3f})")
        return True

    # 놓은 자리에서 바로 홈으로 가면 트레이 셀 안에서 옆으로 쓸며 물체를 친다.
    # 경유점으로 수직 복귀한 뒤 홈으로 간다. 루프를 돌 때 다음 사이클이
    # 같은 조건에서 시작하도록 하는 목적도 있다.
    if not move_abs(approach, f"[{kind}] 경유점으로 복귀"):
        print("  ✗ 경유점 복귀 실패 — 놓기는 됐지만 그 자리에 멈췄습니다")
        return False
    if not a.no_home and not move_home():
        print("  ✗ 홈 복귀 실패")
        return False
    return True


def wait_for_target(reason="대상을 놓쳤습니다"):
    """대상이 화면에서 사라지면 움직이지 않고 다시 나타날 때까지 기다린다.
    물체가 프레임 밖으로 나가거나 가려졌을 때 엉뚱한 곳으로 이동하는 걸 막는다."""
    global tgt, dets, bgr
    print(f"  [대기] {reason} — 다시 나타날 때까지 기다립니다 (로봇 정지)")
    t0_ = time.time(); k = 0
    while True:
        tgt, dets, bgr = observe()
        if tgt is not None:
            print(f"  [대기] 대상 재검출 ({time.time()-t0_:.1f}초 만에) — 정렬을 이어갑니다")
            return True
        k += 1
        if k % 6 == 0:
            print(f"  [대기] {time.time()-t0_:.0f}초 경과, 검출 {len(dets)}개", flush=True)
        show(bgr, dets, None, "waiting for target")
        if a.lost_timeout and (time.time()-t0_) > a.lost_timeout:
            print(f"  [대기] {a.lost_timeout:.0f}초 안에 나타나지 않아 종료합니다")
            return False
        time.sleep(0.5)


def observe(tries=3):
    """현재 대상의 픽셀 위치를 얻는다. 한 번 고른 물체를 계속 추적한다."""
    for _ in range(tries):
        bgr, dep = grab()
        dets = detect(bgr, dep)
        t = track_target(dets)
        if t is not None: return t, dets, bgr
    return None, [], bgr

# ------------------------- 픽셀 오차 → 로봇 이동량 -------------------------
def px_to_mm(err_px, Z):
    """화면 오차(픽셀)를 로봇 이동량(mm)으로 바꾼다.

    핀홀 모델에서 거리 Z 에 있는 물체는 1픽셀이 Z/fx mm 에 해당한다.
    야코비안을 따로 학습하지 않아도 되고, 물체가 멀어지면 자동으로 보폭이 커진다.
    남는 자유도는 '화면 축 ↔ 로봇 축' 대응뿐이라 --map / --sign 으로 준다.
    """
    if np.isnan(Z) or Z <= 0:
        return None
    mm_per_px = Z / FX
    du, dv = float(err_px[0]) * mm_per_px, float(err_px[1]) * mm_per_px
    sx, sy = (1.0 if c.strip() == "+" else -1.0 for c in a.sign.split(","))
    if a.map == "u:x,v:y":
        return np.array([sx * du, sy * dv])
    return np.array([sx * dv, sy * du])          # u:y,v:x


# ---------------------------- 메인 ----------------------------
# 궤적 기록기. --record-traj 가 없으면 아무것도 하지 않는다.
_rec = TrajRecorder(a.record_traj, a.record_fps).start()
if a.record_traj:
    print(f"궤적 기록: {a.record_traj}  @ {a.record_fps:.0f}fps")

try:
    if not a.dry and not cli.wait_for_service(timeout_sec=5.0):
        print("로봇 서비스에 연결할 수 없습니다. ros2_cmd_server 실행 상태를 확인하세요.")
        sys.exit(1)
    # 시작 위치 이동과 좌표계 읽기는 --move 와 무관하게 필요하다
    if not a.dry:
        err = send("GetRobotErrorCode()", force=True)
        print(f"에러코드 -> {err}")
        if err and err.replace(",", "").replace("0", "") != "":
            print("  ⚠️ 로봇에 알람이 있습니다. 티치펜던트에서 리셋한 뒤 다시 실행하세요.")
        print(f"RobotEnable(1) -> {send('RobotEnable(1)', force=True)}")
        time.sleep(1.0)
        # SetSpeed 는 전역 배율이라 둘 중 큰 값으로 둔다. 개별 이동은 명령 인자로 속도를 준다.
        _sp_max = max(a.speed, a.speed_move)
        print(f"SetSpeed({_sp_max}) -> {send(f'SetSpeed({_sp_max})', force=True)}")
        print(f"속도: 서보 {a.speed}% / 큰 이동 {a.speed_move}%")
        if a.tool < 0:
            _t = send("GetActualTCPNum(0)", force=True); TOOL = int(str(_t).split(",")[-1])
        else: TOOL = a.tool
        if a.user < 0:
            _u = send("GetActualWObjNum(0)", force=True); USER = int(str(_u).split(",")[-1])
        else: USER = a.user
        print(f"좌표계: tool={TOOL} user={USER}  (로봇 현재 설정과 맞춰야 tool discrepancy 를 피한다)")
        _r = cur_rpy()
        print(f"자세 유지: rx={_r[0]:.3f} ry={_r[1]:.3f} rz={_r[2]:.3f}  (이동은 {a.movecmd})")

    if a.save_grip_offset:
        # 정렬 기준은 직전 정렬 기록. 홈으로 가면 안 되므로 여기서 끝낸다.
        if not os.path.exists(ALIGNED_FILE):
            sys.exit(f"{ALIGNED_FILE} 가 없습니다. 먼저 --move --hold 로 정렬해 기준을 만드세요.")
        _recs = json.load(open(ALIGNED_FILE))
        if not _recs: sys.exit("정렬 기록이 비어 있습니다.")
        _ref  = _recs[-1]
        _now  = cur_pose()
        _rpy  = cur_rpy()
        _d = [round(float(_now[i] - _ref["tcp"][i]), 2) for i in range(3)]
        _rpy_r = [round(float(v), 3) for v in _rpy]
        # 정렬 때와 자세가 달라졌으면 회전이 섞인 것이다. 그 경우 파지 자세를
        # **절대값**으로 같이 저장하고, 실행 때 "회전 먼저 → 병진" 순서로 쓴다.
        # 오일러 각에 델타를 더하지 않는 이유는 rx 가 ±180 경계 근처라 뒤집히기 때문이다.
        # 각도 차이는 ±180 으로 감아서 잰다. 그냥 빼면 -158.6 과 179.8 의 차이가
        # 338도로 나오지만 실제 회전량은 21.6도다.
        def _wrapdeg(x):
            return (float(x) + 180.0) % 360.0 - 180.0
        _dr = ([abs(_wrapdeg(_rpy[i] - _ref["tcp"][3+i])) for i in range(3)]
               if len(_ref["tcp"]) >= 6 else None)
        _rotated = bool(_dr and max(_dr) > 0.5)
        _out = {"dxyz": _d, "from": _ref,
                "measured_tcp": [round(float(v), 2) for v in _now] + _rpy_r,
                # 실측 당시의 시작 Z 상승분. 다음에 쓸 때 차이만 보상하려면 필요하다.
                "home_lift_mm": round(float(a.home_lift_mm), 2),
                "time": time.strftime("%H:%M:%S")}
        if _rotated:
            _out["grip_rpy_abs"] = _rpy_r
            _out["grip6"] = _d + _rpy_r
            _out["rotated_deg"] = round(max(_dr), 2)
            _out["note"] = ("정렬 자세와 파지 자세가 다르다. 실행 순서는 "
                            "정렬 → 제자리 회전(grip_rpy_abs) → dxyz 병진 하강 이다.")
        json.dump(_out, open(GRIP_FILE, "w"), indent=1, ensure_ascii=False)
        print(f"\n정렬 기준 ({_ref['kind']}) : "
              f"({_ref['tcp'][0]:.2f}, {_ref['tcp'][1]:.2f}, {_ref['tcp'][2]:.2f})  {_ref['time']}")
        print(f"현재 위치           : ({_now[0]:.2f}, {_now[1]:.2f}, {_now[2]:.2f})")
        print(f"상대값 dxyz         : ({_d[0]:+.2f}, {_d[1]:+.2f}, {_d[2]:+.2f}) mm")
        print(f"현재 자세           : ({_rpy_r[0]:.3f}, {_rpy_r[1]:.3f}, {_rpy_r[2]:.3f})")
        print(f"보정값 저장         : {os.path.basename(GRIP_FILE)}")
        if _rotated:
            print(f"\n  회전이 {max(_dr):.2f}도 섞였습니다 — 파지 자세를 절대값으로 같이 저장했습니다.")
            print(f"  6개 값으로 쓰려면 KIND_CFG 의 grip 에 넣으세요:")
            print(f'    "grip": [{_d[0]}, {_d[1]}, {_d[2]}, '
                  f'{_rpy_r[0]}, {_rpy_r[1]}, {_rpy_r[2]}],')
            print("  실행 순서: 정렬 → 제자리 회전 → 병진 하강 (격자 안에서 돌지 않는다)")
        else:
            print("\n  자세가 같습니다 — 순수 병진입니다. dxyz 3개만 쓰면 됩니다.")
        sys.exit(0)

    if a.no_servo:
        # 검출을 안 하므로 종류를 알 수 없다. --kind 로 받고, any 면 탄피로 본다.
        _kind = a.kind if a.kind != "any" else "탄피"
        _cfg = kind_cfg(_kind)
        print(f"[종류] {_kind} (--kind) 설정 사용")
        if _cfg.get("grip") is None:
            sys.exit(f"'{_kind}' 의 보정값이 없습니다. KIND_CFG 에 넣거나 "
                     "--grip-offset \"dx,dy,dz\" 를 주세요.")
        gx, gy, gz = _cfg["grip"][:3]        # 6개면 뒤 3개는 파지 자세다
        gz = grip_dz_compensated(gz)
        aligned = cur_pose()
        print(f"\n[현재 위치] TCP = ({aligned[0]:.2f}, {aligned[1]:.2f}, {aligned[2]:.2f})")
        print(f"[하강] 상대 이동 ({gx:+.2f}, {gy:+.2f}, {gz:+.2f}) mm")
        print(f"       →  목표 {aligned[0]+gx:.2f}, {aligned[1]+gy:.2f}, {aligned[2]+gz:.2f}")
        # X/Y 를 먼저 맞춘 뒤 Z 를 내린다. 비스듬히 들어가면 물체를 밀어낸다.
        if not move_rel(gx, gy, 0.0, speed=a.speed_move):
            sys.exit("XY 보정 이동 실패 — 중단합니다")
        if not move_rel(0.0, 0.0, gz, speed=a.speed_move):
            sys.exit("하강 실패 — 중단합니다")
        _p = cur_pose()
        print(f"[하강 완료] TCP = ({_p[0]:.2f}, {_p[1]:.2f}, {_p[2]:.2f})")
        print(f"[하강 완료] 목표와의 차이 = "
              f"({_p[0]-(aligned[0]+gx):+.2f}, {_p[1]-(aligned[1]+gy):+.2f}, "
              f"{_p[2]-(aligned[2]+gz):+.2f}) mm")
        print(f"\n[그리퍼] {_cfg['close']} 으로 잡습니다")
        gripper(_cfg["close"], force=True, expect_hold=True)
        if not lift(_cfg.get("lift")):
            sys.exit(1)
        if not a.no_place and not move_place(_kind, _cfg):
            sys.exit(1)
        print("\n픽앤플레이스 완료." if not a.no_place
              else "\n하강·파지·들어올리기까지 완료.")
        sys.exit(0)

    if a.dry or a.no_home:
        print("\n[시작 위치] 이동하지 않고 현재 자리에서 시작합니다 "
              f"({'--dry' if a.dry else '--no-home'})")
    else:
        # 그리퍼는 항상 벌린 상태로 시작한다. 닫힌 채로 하강하면 물체를 친다.
        print(f"\n[그리퍼] 활성화 후 {GRIPPER_START} 로 벌립니다")
        print(f"    ActGripper -> {send(f'ActGripper({GRIPPER_ID},1)', force=True)}")
        time.sleep(3.0)
        gripper(GRIPPER_START, force=True)

        if not move_home():
            sys.exit("시작 위치로 이동하지 못했습니다 — 중단합니다")
        time.sleep(0.5)

    tgt, dets, bgr = observe()
    show(bgr, dets, tgt, "target select")
    if tgt is None:
        if not DO_MOVE:
            print("대상을 찾지 못했습니다."); sys.exit(0)
        if not wait_for_target("시작 시 대상이 없습니다"):
            sys.exit(0)
    print(f"\n대상: {tgt['kind']}({tgt['pose']})  픽셀=({tgt['u']:.0f},{tgt['v']:.0f})  "
          f"거리={tgt['Z']:.0f}mm  전체 {len(dets)}개")
    for d in sorted(dets, key=lambda d:(0 if d['kind']=='탄피' else 1)):
        _L = d.get("Lmm", float("nan"))
        _mark = ""
        # Z 로 판정할 때는 경계까지의 여유를 보여준다. 길이 판정일 때만 회색 구간을 경고한다.
        if d.get("by") == "Z" and not np.isnan(d["Z"]):
            _mark = f"  (Z 경계 {a.z_split_mm:.0f} 에서 {abs(d['Z']-a.z_split_mm):.0f}mm)"
        elif d.get("by") == "L" and not np.isnan(_L):
            _mark = f"  (L 경계 {a.len_split_mm:.0f} 에서 {abs(_L-a.len_split_mm):.1f}mm)"
        elif d.get("by") == "밝기":
            _mark = "  ← Z·L 둘 다 못 믿어 밝기로 판정"
        _h = d.get("height")
        _hs = f"h={_h:5.1f}mm" if isinstance(_h, (int, float)) else "h=  없음"
        _m = f"  (+{d['merged']} 중복 제거)" if d.get("merged") else ""
        print(f"   - {d['kind']}({d['pose']}) pix=({d['u']:.0f},{d['v']:.0f}) "
              f"Z={d['Z']:.0f}mm L={_L:.1f}mm {_hs} area={d.get('area',0)}px "
              f"[{d.get('by','?')}]{_m}{_mark}")

    # --- 중심 정렬 ---
    def tol_for(d):
        """물체 반크기. 화면 중심이 물체 안에 들어오면 정렬 완료로 본다."""
        if a.tol_px > 0: return a.tol_px
        return max(a.tol_min_px, 0.5 * min(d.get("Wpx", 0.0), d.get("Lpx", 0.0)))

    print(f"\n[servo] 화면 중심({a.center_x},{a.center_y})으로 정렬. "
          f"허용오차 = 물체 반크기 (하한 {a.tol_min_px}px)")
    print("  순서: X 먼저 → 그다음 Y" if not a.simultaneous else "  X·Y 동시")

    # X/Y 서보는 move_rel(dx, dy, 0.0) 로 Z 를 건드리지 않는다. 카메라는 손목
    # 고정이고 물체는 평면 위이므로 서보 내내 카메라-물체 거리는 상수다.
    # 매 프레임 다시 재면 측정 편차(실측 260~285mm)가 보폭을 10% 흔들 뿐이다.
    Z0 = float(tgt["Z"])
    if np.isnan(Z0) or Z0 <= 0:
        sys.exit(f"대상 깊이를 재지 못했습니다 (Z={tgt['Z']}). "
                 "카메라가 최소 측정거리(약 20cm) 안쪽인지 확인하세요.")
    print(f"  보폭 기준 거리 = {Z0:.0f}mm (선정 시 1회 측정, 서보 중 고정)")

    def servo(axis, label):
        """axis=0 이면 u(가로), 1 이면 v(세로), None 이면 두 축 동시.

        몇 번 만에 맞을지 모르므로 while 로 돈다.
        루프를 끊는 조건은 '화면 중심 오차가 허용치 안'이다.
        max_iter 는 정상 종료 조건이 아니라, 수렴하지 않을 때 무한히 움직이는 걸 막는 보호장치다."""
        global tgt, dets, bgr
        it = 0
        lost_n = 0                                 # 탄두 검출이 연속으로 끊긴 횟수
        while True:
            e_full = np.array([a.center_x - tgt["u"], a.center_y - tgt["v"]])
            tol = tol_for(tgt)
            e = e_full.copy()
            if axis is not None:
                e[1-axis] = 0.0                       # 나머지 축은 이번 단계에서 건드리지 않는다
            mag = float(np.linalg.norm(e))
            if mag <= tol:                      # ← 루프를 끊는 조건
                print(f"  [{label}] {it}회만에 완료 (오차 {mag:.1f}px ≤ 허용 {tol:.1f}px)")
                return True
            if it >= a.max_iter:                # 보호장치
                print(f"  [{label}] {a.max_iter}회를 넘겨도 수렴하지 않아 중단합니다 "
                      f"(마지막 오차 {mag:.1f}px). --gain 을 낮추거나 --sign 을 확인하세요.")
                return False
            it += 1
            last_tgt = dict(tgt)                   # 사라졌을 때 쓸 마지막 관측
            full = px_to_mm(e, Z0)                 # 오차를 전부 없애는 보정량
            step = full * a.gain
            n = np.linalg.norm(step)
            if n > a.max_step_mm: step = step / n * a.max_step_mm
            # 이번에 실제로 명령한 비율. gain 이나 보폭 상한 때문에 1 보다 작을 수 있다.
            frac = min(1.0, float(np.linalg.norm(step)) / max(float(np.linalg.norm(full)), 1e-9))
            resid = mag * (1.0 - frac)             # 이동 후 남을 것으로 예상되는 오차 px
            print(f"  [{label} {it}] 오차 {mag:5.1f}px (허용 {tol:.1f}) "
                  f"→ 상대이동 dx={step[0]:+.1f} dy={step[1]:+.1f} mm")
            if not move_rel(step[0], step[1], 0.0):
                print(f"  [{label}] 이동 실패 — 중단합니다")
                return False
            if not DO_MOVE:
                print("    (미리보기: 이동하지 않으므로 1회만 표시)")
                return False
            time.sleep(0.3)
            tgt, dets, bgr = observe()
            show(bgr, dets, tgt, f"servo {label} {it}")
            if tgt is not None:
                lost_n = 0                             # 다시 잡혔으면 실제 값으로 간다
            if tgt is None:
                # 정렬될수록 위에서 수직으로 내려다보게 되어 SAM3 점수가 떨어진다
                # (09-10 실측: bullet 0.029). 즉 **맞을수록 검출이 죽는다.**
                # 이번에 오차를 전부 명령했고 남을 오차가 허용치 안이면
                # 이미 중앙에 맞은 것이므로 기다리지 않고 하강으로 넘어간다.
                if resid <= tol:
                    print(f"  [{label}] 대상이 사라졌지만 마지막 보정으로 "
                          f"남을 오차가 {resid:.1f}px (허용 {tol:.1f}) — "
                          f"정렬된 것으로 보고 하강으로 넘어갑니다")
                    # 아래 단계가 tgt 의 kind 로 시퀀스를 고르므로 비워둘 수 없다.
                    # 마지막 관측을 화면 중심으로 옮겨 넘긴다 (정렬된 상태로 본다).
                    tgt = dict(last_tgt, u=float(a.center_x), v=float(a.center_y))
                    return True
                # 탄두는 홈에서 한 번 잡히면 그 지점을 잠시 탄두로 찍어 두고 계속 간다.
                # 다가갈수록 위에서 내려다보게 되어 검출이 끊기는데(09-12: 2회 이동 후 0개),
                # 기다리면 영영 안 돌아온다. 명령한 이동만큼 화면에서 옮겨졌다고 보고
                # 남은 오차로 다음 이동을 이어간다. 검출이 돌아오면 실제 값으로 바꾼다.
                if last_tgt.get("kind") == "탄두":        # 정렬될 때까지 유지 (max_iter 가 보호장치)
                    lost_n += 1
                    e_rem = e_full - e * frac          # 이번에 명령한 만큼 줄어든 오차
                    tgt = dict(last_tgt, u=float(a.center_x - e_rem[0]),
                               v=float(a.center_y - e_rem[1]), predicted=True)
                    print(f"  [{label}] 탄두 검출이 끊겼지만 홈에서 찍은 지점으로 계속 갑니다 "
                          f"(예상 오차 {float(np.linalg.norm(e_rem)):.1f}px, 추정 {lost_n}회째)")
                    continue
                if not wait_for_target(f"정렬 중 대상이 화면에서 사라졌습니다 "
                                       f"(남을 오차 {resid:.1f}px > 허용 {tol:.1f})"):
                    return False

    if a.simultaneous:
        ok = servo(None, "XY")
    else:
        ok = servo(0, "X")
        if ok: ok = servo(1, "Y")
        if ok:                       # Y 를 맞추다 X 가 틀어졌는지 확인
            e = np.array([a.center_x - tgt["u"], a.center_y - tgt["v"]])
            tol = tol_for(tgt)
            print(f"  [최종] 오차 {np.linalg.norm(e):.1f}px / 허용 {tol:.1f}px "
                  f"{'OK' if np.linalg.norm(e) <= tol else '— X 재정렬 필요'}")
            if np.linalg.norm(e) > tol and DO_MOVE:
                ok = servo(0, "X재") and servo(1, "Y재")
    if not ok and DO_MOVE:
        sys.exit(1)

    # --- 정렬 완료. 여기서 멈춘 좌표가 기준이 된다 ---
    try:
        aligned = cur_pose()
    except TimeoutError:
        aligned = np.zeros(3); print("  (로봇 상태를 읽지 못해 정렬 좌표를 0으로 표시합니다)")
    print(f"\n[정렬 완료] 대상 = {tgt['kind']}({tgt['pose']})")
    print(f"[정렬 완료] TCP  = ({aligned[0]:.2f}, {aligned[1]:.2f}, {aligned[2]:.2f})")
    print(f"[정렬 완료] 픽셀 = ({tgt['u']:.1f}, {tgt['v']:.1f})  "
          f"화면 중심 ({a.center_x:.0f}, {a.center_y:.0f})")
    # 보정값 기준은 **정렬된 상태**의 측정치여야 한다. 선정 시점 값은 물체가 화면
    # 구석에 있을 때 비스듬히 본 것이라 물체마다 보는 각도가 달라 비교가 안 된다.
    # tgt 는 서보 루프에서 매 회차 갱신되므로 여기 값이 곧 중심에서 본 값이다.
    _Lc = tgt.get("Lmm", float("nan"))
    _hc = tgt.get("height", float("nan"))
    print(f"[정렬 완료] 측정 = Z {tgt['Z']:.0f}mm  L {_Lc:.1f}mm  h {_hc:.1f}mm"
          f"   ← 보정 기준은 이 값이다 (선정 시점 값이 아니다)")
    try:
        _rpy = cur_rpy()
        _jr  = send("GetActualJointPosDegree(0)", force=True)
        _jj  = [float(v) for v in str(_jr).split(",")][1:7]
        print("[정렬 완료] 관절 = [" + ", ".join(f"{v:.3f}" for v in _jj) + "]")
        _prev = json.load(open(ALIGNED_FILE)) if os.path.exists(ALIGNED_FILE) else []
        _prev.append({"kind": tgt["kind"], "pose": tgt["pose"],
                      "tcp": [round(float(v), 3) for v in aligned]
                             + [round(float(v), 3) for v in _rpy],
                      "joints": [round(v, 3) for v in _jj],
                      "pixel": [round(tgt["u"], 1), round(tgt["v"], 1)],
                      # 정렬된 상태의 측정치. 보정 계수를 나중에 다시 뽑으려면
                      # 이게 남아 있어야 한다 — 선정 시점 값은 각도가 제각각이다.
                      "Z_mm": None if np.isnan(tgt["Z"]) else round(float(tgt["Z"]), 1),
                      "L_mm": None if np.isnan(_Lc) else round(float(_Lc), 2),
                      "h_mm": None if not isinstance(_hc, (int, float)) or np.isnan(_hc)
                              else round(float(_hc), 2),
                      "time": time.strftime("%H:%M:%S")})
        json.dump(_prev, open(ALIGNED_FILE, "w"), indent=1, ensure_ascii=False)
        print(f"[정렬 완료] 기록 추가: {os.path.basename(ALIGNED_FILE)} ({len(_prev)}건)")
    except Exception as _e:
        print(f"[정렬 완료] 기록 실패: {_e}")

    if a.descend:
        # 검출된 종류에 따라 파지 보정값·놓기 좌표·그리퍼 값이 갈린다.
        _kind = tgt["kind"]
        _cfg  = kind_cfg(_kind)
        print(f"\n[종류] {_kind} 설정 사용 — "
              f"보정값 {'있음' if _cfg.get('grip') else '없음'}, "
              f"놓기 {'있음' if _cfg.get('pose') else '없음'}, "
              f"박기 {len(_cfg.get('press') or [])}단계, "
              f"마무리 {len(_cfg.get('after') or [])}단계, 그리퍼 {_cfg['close']}")
        if _cfg.get("grip") is None:
            sys.exit(f"'{_kind}' 의 파지 보정값이 없습니다. "
                     f"KIND_CFG['{_kind}']['grip'] 에 넣거나 --grip-offset 을 주세요. "
                     "실측은 --save-grip-offset 으로 합니다.")
        gx, gy, gz = _cfg["grip"][:3]        # 6개면 뒤 3개는 파지 자세다
        gz = grip_dz_compensated(gz)
        # 보정값이 6개면 뒤 3개가 파지 자세(절대 rx,ry,rz)다. 하강 전에 회전한다.
        _g6 = _cfg["grip"]
        if len(_g6) >= 6:
            if not rotate_to(_g6[3:6], "파지 자세로 회전"):
                sys.exit("파지 자세 회전 실패 — 중단합니다")
            aligned = cur_pose()          # 회전으로 TCP 가 움직였을 수 있다
        print(f"\n[하강] 상대 이동 ({gx:+.2f}, {gy:+.2f}, {gz:+.2f}) mm")
        print(f"       정렬 {aligned[0]:.2f}, {aligned[1]:.2f}, {aligned[2]:.2f}"
              f"  →  목표 {aligned[0]+gx:.2f}, {aligned[1]+gy:.2f}, {aligned[2]+gz:.2f}")
        if gz < -160.0:
            print(f"       ⚠️ Z 를 {abs(gz):.0f}mm 내립니다. 처음이면 --grip-offset "
                  f'"{gx:.1f},{gy:.1f},-150" 으로 덜 내려 X/Y 만 먼저 확인하세요.')
        # X/Y 를 먼저 맞춘 뒤 Z 를 내린다. 비스듬히 들어가면 물체를 밀어낸다.
        if not move_rel(gx, gy, 0.0, speed=a.speed_move):
            sys.exit("XY 보정 이동 실패 — 중단합니다")
        if not move_rel(0.0, 0.0, gz, speed=a.speed_move):
            sys.exit("하강 실패 — 중단합니다")
        _p = cur_pose()
        print(f"[하강 완료] TCP = ({_p[0]:.2f}, {_p[1]:.2f}, {_p[2]:.2f})")
        print(f"[하강 완료] 목표와의 차이 = "
              f"({_p[0]-(aligned[0]+gx):+.2f}, {_p[1]-(aligned[1]+gy):+.2f}, "
              f"{_p[2]-(aligned[2]+gz):+.2f}) mm")
        print(f"\n[그리퍼] {_cfg['close']} 으로 잡습니다")
        gripper(_cfg["close"], expect_hold=True)
        print("  그리퍼 LED가 초록색인지 확인하세요.")
        if not lift(_cfg.get("lift")):
            sys.exit(1)
        if not a.no_place and not move_place(_kind, place_h_correct(_cfg, tgt)):
            sys.exit(1)
        print("\n픽앤플레이스 완료." if not a.no_place
              else "\n하강·파지·들어올리기까지 완료.")
        sys.exit(0)

    if a.hold:
        print("\n정렬 완료. 그 자리에서 대기합니다. Ctrl+C 로 종료.")
        if not a.hold_redo:
            print("  (대기 중에는 움직이지 않습니다. 재정렬하려면 --hold-redo)")
        try:
            k = 0
            while True:
                t2, dets2, bgr2 = observe()
                if t2 is None:
                    print("  [대기] 대상이 화면에서 사라졌습니다 — 로봇 정지 상태 유지")
                    time.sleep(0.5); continue
                e = np.array([a.center_x - t2["u"], a.center_y - t2["v"]])
                tol2 = tol_for(t2); mag = float(np.linalg.norm(e))
                k += 1
                print(f"  [{k}] {t2['kind']}({t2['pose']}) 중심=({t2['u']:.0f},{t2['v']:.0f}) "
                      f"오차 {mag:5.1f}px / 허용 {tol2:4.1f}  "
                      f"{'OK' if mag <= tol2 else '벗어남'}", flush=True)
                show(bgr2, dets2, t2, f"hold {k}")
                if a.hold_redo and mag > tol2:
                    step = px_to_mm(e, Z0)
                    if step is None: continue
                    step = step * a.gain
                    nn = np.linalg.norm(step)
                    if nn > a.max_step_mm: step = step / nn * a.max_step_mm
                    print(f"      재정렬 dx={step[0]:+.1f} dy={step[1]:+.1f} mm")
                    move_rel(step[0], step[1], 0.0)
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\n대기 종료. 로봇은 그 자리에 있습니다.")
        sys.exit(0)
    print("\n정렬까지 완료. 여기까지가 검증된 범위입니다.")
    sys.exit(0)

finally:
    try:
        _rec.save()
    except Exception as _e:
        print(f"[궤적] 저장 실패: {_e}")
    if a.display: cv2.destroyAllWindows()
    node.destroy_node(); rclpy.shutdown()
