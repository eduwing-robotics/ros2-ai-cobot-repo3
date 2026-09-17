#
# [수정판 v2] 훈련 단계에서 평가 보상(reward) 기준 실제 상위 5개 모델을 추적/보관하고,
# 재생 단계에서 하나의 MuJoCo 씬에 실제 FR5 로봇 4대를 나란히 배치해 동시 시각화하며,
# 5번째 로봇은 자신만의 독립된 시뮬레이션 상태로 실제 학원 FR5 로봇 팔과 통신하는 인터페이스로 분리
#
# v1 대비 수정 사항:
#   1) FR5_MJCF_PATH가 tool0/casing 이 없는 구버전 XML을 가리키던 문제 -> 실제 수정본 경로로 교정 + 자동 탐색
#   2) launch_passive 를 4번 호출해 코어덤프 나던 문제
#      -> 로봇 4대를 하나의 씬에 복제 배치하고 뷰어 1개로 동시 관찰 (FleetViewer)
#   3) IK가 관절 리밋을 넘고 도달 불가 지점을 노리던 문제
#      -> 관절 리밋 클램핑 + 팔 6축만 사용 + 작업 원점을 팔이 닿는 위치로 이동(TASK_FRAME_ORIGIN)
#   4) tool0 site가 손목 중심(0,0,0)이라 25cm 오차가 있던 문제 -> 그리퍼 파지 중심으로 이동 (XML 수정)
#   5) 가상 로봇 4대가 성공/타임아웃 후에도 리셋되지 않아 멈춰 있던 문제 -> 에피소드 자동 리셋
#   6) casing body 조회 실패(-1)를 방어하지 않던 문제 -> 이름 조회 결과를 전부 검증
#
import gymnasium as gym
from gymnasium import spaces
import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.evaluation import evaluate_policy
from stable_baselines3.common.monitor import Monitor
import copy
import os
import re
import sys
import time
import xml.etree.ElementTree as ET

# MuJoCo는 선택 의존성으로 처리 (설치 안 되어 있어도 학습/평가는 정상 동작해야 함)
try:
    import mujoco
    import mujoco.viewer
    MUJOCO_AVAILABLE = True
except ImportError:
    MUJOCO_AVAILABLE = False


# ──────────────────────────────────────────────────────────
# 📁 [수정 1] MJCF 경로: tool0 site + casing mocap 이 실제로 들어있는 파일을 찾아 쓴다
# ──────────────────────────────────────────────────────────
# 이 파일 옆의 것 하나만 쓴다 (2026-09-03).
# **폴백을 없앤 이유** — 예전 목록에는 `share/urdf/` 사본이 마지막 후보로 있었는데,
# 그건 08-12 판이라 탄두·탄피 메시도 그리퍼 분할도 없었다. 앞의 후보가 하나라도
# 어긋나면 **조용히 낡은 로봇이 떴다.** 못 찾으면 조용히 대체하는 대신 죽는 게 낫다.
_MJCF_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fairino5_v6_mjmodel.xml"),
]
EE_SITE_NAME = "tool0"       # wrist3_link 에 삽입한 site (그리퍼 파지 중심)
CASING_BODY_NAME = "casing"  # 탄피 케이싱 mocap body

# 학습 환경의 좌표계는 "작업 국소 좌표계"(케이싱이 원점 위 CASE_CENTER_Z=0.1m).
# 그것을 월드 어디에 놓을지가 TASK_FRAME_ORIGIN 이다.
#
# ⚠ **2026-09-07: 하드코딩(-0.45,0,0)을 버리고 MJCF 에서 읽는다.**
#   예전에는 탄피가 (0,0,0.1) 즉 로봇 베이스 바로 위(도달 불가)에 있어서, 시각화할 때만
#   팔 앞쪽 45cm 로 옮겨 놓는 임시값을 썼다. 지금은 MJCF 에 **실측 위치의 탄피와
#   작업대(책상·받침판·고정대)** 가 들어 있으므로, 원점을 하드코딩하면 탄피(mocap 으로
#   매 프레임 여기에 놓인다)와 고정대(정적)가 **따로 놀아 탄피가 허공에 뜬다.**
#   그래서 MJCF 의 casing body 위치에서 역산해 항상 붙어 있게 한다.
CASE_CENTER_Z = 0.10        # 국소 좌표계에서 탄피 **중심**의 높이 (fr5_screw_assembly 와 동일)
TASK_FRAME_ORIGIN = np.array([-0.45, 0.0, 0.0])   # 아래에서 MJCF 값으로 덮어쓴다
FLEET_SPACING = 1.2      # (구) 1열 배치의 y축 간격(m) — n>5 일 때만 쓴다
# ⚠ 2026-09-07: 1열로 늘어놓으니 한 번에 안 보여서 **가운데 1대 + 네 구역** 배치로 바꿨다.
#   간격을 이만큼 좁히면 로봇마다 깔린 책상(1.0 x 0.9 m)이 서로 겹친다. 그래서 아래
#   _build_fleet_xml 에서 **로봇별 책상을 빼고 큰 공유 작업대 하나로 대체**한다.
FLEET_SPACING_X = 0.75
FLEET_SPACING_Y = 0.75
# 좌뒤 · 우뒤 · 좌앞 · 우앞. 작업 영역이 로봇 기준 (-x,-y) 라 "앞"은 -y 쪽이다.
_FLEET_QUADRANTS = ((-1, +1), (+1, +1), (-1, -1), (+1, -1))


def fleet_offsets(n_robots, highlight_idx=None):
    """로봇 베이스 오프셋. **금색(실물 이식 대상)을 가운데 두고 나머지를 네 구역에** 놓는다.

    5대까지만 이 배치를 쓴다. 그보다 많으면 예전처럼 y축 1열로 돌아간다 —
    구역이 넷뿐이라 더 넣을 자리가 없다.
    """
    if n_robots <= 1:
        return [np.zeros(3)]
    if highlight_idx is None or n_robots > 5:
        return [np.array([0.0, (i - (n_robots - 1) / 2.0) * FLEET_SPACING, 0.0])
                for i in range(n_robots)]
    out, q = [], 0
    for i in range(n_robots):
        if i == highlight_idx:
            out.append(np.zeros(3))            # 가운데
        else:
            sx, sy = _FLEET_QUADRANTS[q]; q += 1
            out.append(np.array([sx * FLEET_SPACING_X, sy * FLEET_SPACING_Y, 0.0]))
    return out

# 테스트 모드: 실물 이식 대상(최고 성능) 모델을 시뮬레이션 '중앙'에도 함께 띄운다.
# 실제 하드웨어에 물릴 때 False 로 두면 중앙 로봇은 화면에서 빠지고
# send_command_to_real_fr5_robot() 으로만 명령이 나간다.
TEST_MODE = True

# 재생용 비교 모델: top-5 는 전부 학습 후반부라 움직임이 똑같으므로,
# 학습 곡선의 서로 다른 구간을 뽑아 '미숙 -> 숙련' 차이가 눈에 보이게 한다.
CURRICULUM_STEPS = (25000, 75000, 150000, 250000)
REPLAY_STEPS = 200  # 재생 단계 총 스텝 수

# 중앙(실물 이식 대상) 로봇은 금색으로 구분 표시
HIGHLIGHT_RGBA = "0.95 0.72 0.15 1"
_BODY_RGBA = "0.89804 0.91765 0.92941 1"  # 원본 링크 색 (이 색만 교체해 그리퍼 검정은 유지)


def resolve_mjcf_path():
    """tool0 site 와 casing mocap body 가 모두 들어있는 MJCF 를 골라 반환."""
    checked = []
    for path in _MJCF_CANDIDATES:
        if not os.path.exists(path):
            checked.append(f"  - {path} (파일 없음)")
            continue
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as exc:
            checked.append(f"  - {path} (XML 파싱 실패: {exc})")
            continue
        names = {el.get("name") for el in root.iter()}
        missing = [n for n in (EE_SITE_NAME, CASING_BODY_NAME) if n not in names]
        if missing:
            checked.append(f"  - {path} ({', '.join(missing)} 없음)")
            continue
        return path
    raise RuntimeError(
        "tool0 site 와 casing mocap body 를 모두 갖춘 MJCF 를 찾지 못했습니다.\n"
        + "\n".join(checked)
        + "\n  wrist3_link 안에 <site name=\"tool0\" .../>, worldbody 에 "
          "<body name=\"casing\" mocap=\"true\">... 를 추가하세요."
    )


def task_frame_origin_from(mjcf_path):
    """MJCF 의 casing body 위치에서 작업 국소 좌표계의 원점을 역산한다.

    casing body 원점 = 탄피 **중심** 이고 국소 좌표계에서 그 높이가 CASE_CENTER_Z 이므로,
    월드 원점 = casing_pos - (0, 0, CASE_CENTER_Z) 다.
    이렇게 해 두면 MJCF 에서 탄피/작업대를 옮겨도 여기가 따라온다.
    """
    root = ET.parse(mjcf_path).getroot()
    for body in root.find("worldbody").iter("body"):
        if body.get("name") == CASING_BODY_NAME:
            pos = np.fromstring(body.get("pos", "0 0 0"), sep=" ")
            return pos - np.array([0.0, 0.0, CASE_CENTER_Z])
    return np.array([-0.45, 0.0, 0.0])


try:
    TASK_FRAME_ORIGIN = task_frame_origin_from(resolve_mjcf_path())
except Exception:
    # MJCF 를 못 찾아도 import 는 되게 둔다 — 쓰는 쪽에서 어차피 다시 찾다가 제대로 실패한다
    pass


# ──────────────────────────────────────────────────────────
# 🧩 환경 정의 (순수 수치 시뮬레이션 — 렌더링은 FleetViewer 가 전담)
# ──────────────────────────────────────────────────────────
class FR5ScrewAssemblyEnv(gym.Env):
    metadata = {"render_modes": ["human"], "render_fps": 30}

    def __init__(self, render_mode=None, env_id=0):
        super().__init__()
        self.render_mode = render_mode
        self.env_id = env_id  # 플릿 내 로봇 구분용 ID
        self.action_space = spaces.Box(low=-1.0, high=1.0, shape=(6,), dtype=np.float32)
        self.observation_space = spaces.Box(low=-np.inf, high=np.inf, shape=(13,), dtype=np.float32)
        self.bullet_casing_pos = np.array([0.0, 0.0, 0.1])
        self.screw_pitch = 0.02

        self.robot_ee_pos = None
        self.robot_ee_ori = None
        self.current_step = 0
        self.reset()

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        # 각 로봇마다 초기 오차를 다르게 주어 다각도 검증 가능하게 함
        self.robot_ee_pos = np.array([
            self.np_random.uniform(-0.005, 0.005),
            self.np_random.uniform(-0.005, 0.005),
            0.15,
        ])
        self.robot_ee_ori = np.array([0.0, 0.0, self.np_random.uniform(-np.pi, np.pi)])
        self.current_step = 0
        return self._get_obs(), {}

    def _get_obs(self):
        rel_pos = self.bullet_casing_pos - self.robot_ee_pos
        simulated_force = np.array([1.0 if self.robot_ee_pos[2] <= 0.12 else 0.0])
        return np.concatenate(
            [self.robot_ee_pos, self.robot_ee_ori, self.bullet_casing_pos, rel_pos, simulated_force]
        ).astype(np.float32)

    def step(self, action):
        self.current_step += 1
        pos_step = action[:3] * 0.005
        ori_step = action[3:] * 0.05

        self.robot_ee_pos += pos_step
        self.robot_ee_ori += ori_step

        if self.robot_ee_pos[2] <= 0.12:
            self.robot_ee_pos[2] += (ori_step[2] / (2 * np.pi)) * self.screw_pitch

        if self.robot_ee_pos[2] < 0.075:
            self.robot_ee_pos[2] = 0.075

        # [보상 밸런싱] 멀티 로봇들도 겉돌지 않도록 페널티 강화
        dist = np.linalg.norm(self.bullet_casing_pos - self.robot_ee_pos)
        reward = -dist * 50.0
        alignment_penalty = -np.linalg.norm(self.robot_ee_ori[:2]) * 10.0
        reward += alignment_penalty

        if self.robot_ee_pos[2] <= 0.12:
            reward += abs(ori_step[2]) * 15.0
            reward += (0.12 - max(self.robot_ee_pos[2], 0.08)) * 200.0

        # [정밀 안착 판정] 성공 거리 마진 3.2cm
        success = self.robot_ee_pos[2] <= 0.082 and dist < 0.032
        if success:
            reward += 5000.0

        terminated = bool(success)
        truncated = self.current_step >= 200
        return self._get_obs(), reward, terminated, truncated, {}

    def render(self):
        # 시각화는 FleetViewer 가 로봇 전체를 한 씬에서 담당한다.
        # (뷰어를 env 마다 띄우면 launch_passive 가 프로세스당 1개 제한이라 크래시)
        return None

    def close(self):
        return None


# ──────────────────────────────────────────────────────────
# 🖥️ [수정 2·3·4·6] 로봇 4대를 한 씬에 배치해 뷰어 1개로 동시 관찰
# ──────────────────────────────────────────────────────────
class FleetViewer:
    """
    launch_passive 는 프로세스당 1개만 안정적으로 뜨므로(2개 이상은 코어덤프),
    실제 FR5 모델을 n대 복제해 하나의 씬에 나란히 배치하고 뷰어 하나로 전부 본다.

    학습 env 의 좌표는 '작업 국소 좌표계'라서,
    world = 로봇 베이스 오프셋 + TASK_FRAME_ORIGIN + 국소좌표 로 매핑한다.
    """

    ARM_JOINTS = ("j1", "j2", "j3", "j4", "j5", "j6")
    HOME_QPOS = np.array([0.0, -1.0, 1.2, -1.7, -1.57, 0.0])

    def __init__(self, n_robots, mjcf_path, highlight_idx=None):
        self.n_robots = n_robots
        self.highlight_idx = highlight_idx  # 실물 이식 대상 로봇 (금색 표시)
        self.base_offsets = fleet_offsets(n_robots, highlight_idx)
        fleet_xml = self._build_fleet_xml(mjcf_path)
        self.model = mujoco.MjModel.from_xml_path(fleet_xml)
        self.data = mujoco.MjData(self.model)

        self.site_ids, self.mocap_ids, self.arm_dofs, self.arm_qpos = [], [], [], []
        for i in range(n_robots):
            p = f"r{i}_"
            self.site_ids.append(self._require(mujoco.mjtObj.mjOBJ_SITE, p + EE_SITE_NAME))
            body_id = self._require(mujoco.mjtObj.mjOBJ_BODY, p + CASING_BODY_NAME)
            mocap_id = int(self.model.body_mocapid[body_id])
            if mocap_id < 0:
                raise RuntimeError(
                    f"'{p + CASING_BODY_NAME}' body 에 mocap=\"true\" 가 설정되어 있지 않습니다."
                )
            self.mocap_ids.append(mocap_id)
            joints = [self._require(mujoco.mjtObj.mjOBJ_JOINT, p + j) for j in self.ARM_JOINTS]
            self.arm_dofs.append(np.array([self.model.jnt_dofadr[j] for j in joints]))
            self.arm_qpos.append(np.array([self.model.jnt_qposadr[j] for j in joints]))
            # 특이점에서 먼 초기 자세로 시작해야 IK 가 안정적으로 수렴한다
            self.data.qpos[self.arm_qpos[-1]] = self.HOME_QPOS

        self.jnt_lo = self.model.jnt_range[:, 0]
        self.jnt_hi = self.model.jnt_range[:, 1]
        self._jac = np.zeros((3, self.model.nv))
        mujoco.mj_forward(self.model, self.data)
        self.viewer = mujoco.viewer.launch_passive(self.model, self.data)

    # -- 이름 조회 실패(-1)를 조용히 넘기지 않는다 [수정 6] -------------------
    def _require(self, objtype, name):
        obj_id = mujoco.mj_name2id(self.model, objtype, name)
        if obj_id < 0:
            raise RuntimeError(f"생성된 플릿 씬에서 '{name}' 을(를) 찾을 수 없습니다.")
        return obj_id

    @staticmethod
    def _scene_min_z(src_worldbody):
        """원본 worldbody 안 박스 geom 들의 최저 z. 바닥 평면을 그 아래에 깔려고 쓴다.

        박스만 본다 — 메시는 정점을 읽어야 정확한데, 작업대의 최저점은 항상 책상(박스)이라
        박스만으로 충분하다. 아무것도 못 찾으면 0.0 을 돌려 이전 동작(z=0)과 같아진다.
        """
        lo = 0.0
        for geom in src_worldbody.iter("geom"):
            if geom.get("type") != "box":
                continue
            try:
                pz = float(geom.get("pos", "0 0 0").split()[2])
                sz = float(geom.get("size", "0 0 0").split()[2])
            except (IndexError, ValueError):
                continue
            lo = min(lo, pz - sz)
        return lo

    # -- 단일 로봇 MJCF 를 n대로 복제한 플릿 씬 생성 [수정 2] ----------------
    def _build_fleet_xml(self, mjcf_path):
        src = ET.parse(mjcf_path).getroot()
        root = ET.Element("mujoco", {"model": "fr5_fleet"})
        for tag in ("compiler", "option", "size", "default", "asset"):
            for el in src.findall(tag):
                root.append(copy.deepcopy(el))  # mesh 에셋은 전 로봇이 공유
        vis = ET.SubElement(root, "visual")
        ET.SubElement(vis, "headlight", {"ambient": "0.5 0.5 0.5", "diffuse": "0.45 0.45 0.45",
                                         "specular": "0.1 0.1 0.1"})
        ET.SubElement(vis, "quality", {"shadowsize": "0"})   # 그림자 맵 자체를 끈다
        span = float(np.max(np.abs(np.array(self.base_offsets)))) if self.base_offsets else 0.0
        ET.SubElement(root, "statistic", {
            "center": f"{TASK_FRAME_ORIGIN[0]} {TASK_FRAME_ORIGIN[1]} 0.3",
            "extent": str(max(2.0, 2.0 * span + 2.0)),
        })

        src_worldbody = src.find("worldbody")
        desk_geoms = []          # 로봇별 책상은 여기 모아 두고 공유 작업대 하나로 대체한다
        worldbody = ET.SubElement(root, "worldbody")
        # ⚠ 그림자 끔 (2026-09-07). 탄두·탄피가 Ø9~10mm 밖에 안 되는데 팔 그림자가 그 위에
        #   떨어지면 안 보인다. 조명도 둘로 나눠 한쪽에서만 오는 그늘을 없앤다.
        ET.SubElement(worldbody, "light", {"pos": "0 0 3", "dir": "0 0 -1",
                                           "directional": "true", "castshadow": "false",
                                           "diffuse": "0.6 0.6 0.6"})
        ET.SubElement(worldbody, "light", {"pos": "-2 -2 2", "dir": "0.5 0.5 -1",
                                           "directional": "true", "castshadow": "false",
                                           "diffuse": "0.35 0.35 0.35"})

        # ⚠ 바닥 평면 높이를 **씬에서 자동으로** 정한다 (2026-09-07).
        #   전에는 z=0 고정이었는데, 단일 로봇 MJCF 에 작업대(desk/riser/고정대)가
        #   들어오면서 그 아래쪽이 z=0 보다 낮아졌다. 그대로 두면 **책상이 바닥에 묻혀**
        #   안 보이고, 고정대·탄피 하단도 잘린다. 그래서 씬의 최저점보다 10mm 아래에 깐다.
        floor_z = min(-0.05, self._scene_min_z(src_worldbody) - 0.010)
        ET.SubElement(worldbody, "geom", {
            "name": "floor", "type": "plane",
            "pos": f"0 0 {floor_z:.6f}",
            "size": f"{max(5.0, span + 3.0)} {max(5.0, span + 3.0)} 0.05",
            "rgba": "0.28 0.30 0.34 1",
        })

        src_contact = src.find("contact")
        src_excludes = list(src_contact) if src_contact is not None else []
        contact = ET.SubElement(root, "contact")
        for i in range(self.n_robots):
            prefix = f"r{i}_"
            for body in src_worldbody.findall("body"):
                clone = copy.deepcopy(body)
                for el in clone.iter():
                    if "name" in el.attrib:  # mesh= 참조는 건드리지 않으므로 에셋 공유 유지
                        el.set("name", prefix + el.get("name"))
                    # 중앙(실물 이식 대상) 로봇만 링크 색을 금색으로 (그리퍼 검정은 그대로 유지)
                    if i == self.highlight_idx and el.get("rgba") == _BODY_RGBA:
                        el.set("rgba", HIGHLIGHT_RGBA)
                pos = np.fromstring(clone.get("pos", "0 0 0"), sep=" ") + self.base_offsets[i]
                clone.set("pos", " ".join(f"{v:.6f}" for v in pos))
                # ⚠ 로봇별 책상은 뺀다 — 간격을 좁히면 서로 겹친다. 대신 아래에서
                #   공유 작업대 하나를 깐다. 받침판·고정대·탄피는 로봇마다 그대로 둔다.
                for holder in clone.iter():
                    for g in list(holder.findall("geom")):
                        if g.get("name") == prefix + "desk":
                            holder.remove(g)
                            desk_geoms.append(g)
                worldbody.append(clone)
            for exclude in src_excludes:
                new_ex = copy.deepcopy(exclude)
                for attr in ("body1", "body2"):
                    if attr in new_ex.attrib:
                        new_ex.set(attr, prefix + new_ex.get(attr))
                contact.append(new_ex)

        # -- 공유 작업대 하나 --------------------------------------------------
        # 로봇별 책상을 빼고, 같은 높이·두께로 전 로봇을 덮는 큰 판 하나를 깐다.
        # 높이는 원본 책상에서 그대로 읽어 오므로 MJCF 를 고치면 여기가 따라온다.
        if desk_geoms:
            g0 = desk_geoms[0]          # geom pos 는 body 국소좌표라 오프셋이 안 섞여 있다
            dx0, dy0, dz = (float(v) for v in g0.get("pos", "0 0 0").split())
            dh = float(g0.get("size", "0 0 0").split()[2])
            offs = np.array(self.base_offsets)
            cx = dx0 + float(offs[:, 0].mean())
            cy = dy0 + float(offs[:, 1].mean())
            hx = float(offs[:, 0].max() - offs[:, 0].min()) / 2.0 + 0.60
            hy = float(offs[:, 1].max() - offs[:, 1].min()) / 2.0 + 0.60
            ET.SubElement(worldbody, "geom", {
                "name": "shared_desk", "type": "box",
                "pos": f"{cx:.6f} {cy:.6f} {dz:.6f}",
                "size": f"{hx:.6f} {hy:.6f} {dh:.6f}",
                "rgba": g0.get("rgba", "0.90 0.90 0.88 1"),
            })

        out_path = os.path.join(os.path.dirname(mjcf_path), "_fr5_fleet_generated.xml")
        ET.ElementTree(root).write(out_path, encoding="utf-8", xml_declaration=True)
        return out_path

    # -- 관절 리밋을 지키는 damped least-squares IK [수정 3] -----------------
    def _solve_ik(self, robot_idx, target_pos, max_iters=40, tol=1e-4, step_gain=0.6, damping=1e-3):
        site_id = self.site_ids[robot_idx]
        dofs, qadr = self.arm_dofs[robot_idx], self.arm_qpos[robot_idx]
        for _ in range(max_iters):
            mujoco.mj_forward(self.model, self.data)
            err = target_pos - self.data.site_xpos[site_id]
            if np.linalg.norm(err) < tol:
                break
            mujoco.mj_jacSite(self.model, self.data, self._jac, None, site_id)
            jac = self._jac[:, dofs]  # 팔 6축만 사용 (그리퍼 slide 관절 제외)
            dq = jac.T @ np.linalg.solve(jac @ jac.T + damping * np.eye(3), err)
            # 관절 리밋 클램핑: 물리적으로 불가능한 자세로 꺾이는 것을 방지
            self.data.qpos[qadr] = np.clip(
                self.data.qpos[qadr] + dq * step_gain, self.jnt_lo[qadr], self.jnt_hi[qadr]
            )

    def sync(self, ee_local_positions, casing_local_positions):
        """국소 작업좌표계의 EE/케이싱 위치 리스트를 받아 씬 전체를 갱신."""
        if self.viewer is None or not self.viewer.is_running():
            return False
        for i in range(self.n_robots):
            frame = self.base_offsets[i] + TASK_FRAME_ORIGIN
            self.data.mocap_pos[self.mocap_ids[i]] = frame + casing_local_positions[i]
            self._solve_ik(i, frame + ee_local_positions[i])
        mujoco.mj_forward(self.model, self.data)
        self.viewer.sync()
        return True

    def tracking_errors(self, ee_local_positions):
        """IK 가 목표 EE 위치를 실제로 따라갔는지(mm) — 데모 중 신뢰도 확인용."""
        errs = []
        for i in range(self.n_robots):
            target = self.base_offsets[i] + TASK_FRAME_ORIGIN + ee_local_positions[i]
            errs.append(float(np.linalg.norm(target - self.data.site_xpos[self.site_ids[i]]) * 1000))
        return errs

    def close(self):
        if self.viewer is not None:
            try:
                self.viewer.close()
            except Exception:
                pass  # mujoco 뷰어 teardown 은 환경에 따라 예외가 날 수 있어 무시
            self.viewer = None


# ──────────────────────────────────────────────────────────
# 🏆 평가 보상 기준 실제 top-K 모델 추적 콜백
# ──────────────────────────────────────────────────────────
class TopKEvalCallback(BaseCallback):
    """
    save_freq 스텝마다 정책을 평가(evaluate_policy)하고,
    지금까지의 상위 k개 모델만 디스크에 남긴다.
    (순수 주기 저장이 아니라 '진짜 최고 성능' k개를 보관)
    """

    def __init__(self, eval_env, save_path, k=5, save_freq=25000, n_eval_episodes=5,
                 milestone_steps=(), milestone_path=None, verbose=1):
        super().__init__(verbose)
        self.eval_env = eval_env
        self.save_path = save_path
        self.k = k
        self.save_freq = save_freq
        self.n_eval_episodes = n_eval_episodes
        self.top_models = []  # [(score, path), ...] score 내림차순 정렬 유지
        # 마일스톤 스냅샷: 점수와 무관하게 무조건 보관 (재생 시 학습 진행도 비교용)
        self.milestone_steps = set(milestone_steps)
        self.milestone_path = milestone_path
        self.milestone_files = {}  # {step: path}

    def _init_callback(self):
        os.makedirs(self.save_path, exist_ok=True)
        if self.milestone_path:
            os.makedirs(self.milestone_path, exist_ok=True)

    def _on_step(self) -> bool:
        if self.n_calls % self.save_freq == 0:
            mean_reward, std_reward = evaluate_policy(
                self.model, self.eval_env, n_eval_episodes=self.n_eval_episodes
            )
            candidate_path = os.path.join(self.save_path, f"candidate_{self.num_timesteps}steps.zip")
            self.model.save(candidate_path)
            self.top_models.append((mean_reward, candidate_path))
            self.top_models.sort(key=lambda item: item[0], reverse=True)

            if len(self.top_models) > self.k:
                worst_score, worst_path = self.top_models.pop()  # 가장 낮은 점수 제거
                if os.path.exists(worst_path):
                    os.remove(worst_path)

            if self.num_timesteps in self.milestone_steps and self.milestone_path:
                snap = os.path.join(self.milestone_path, f"curriculum_{self.num_timesteps}steps.zip")
                self.model.save(snap)
                self.milestone_files[self.num_timesteps] = snap

            if self.verbose:
                ranks = ", ".join(f"{s:.1f}" for s, _ in self.top_models)
                print(f"🏅 [TopK 평가] step={self.num_timesteps} 방금점수={mean_reward:.2f}(±{std_reward:.2f}) "
                      f"현재 top-{len(self.top_models)} 점수: [{ranks}]")
        return True

    def get_top_paths_best_first(self):
        return [path for _, path in self.top_models]

    def get_curriculum_paths(self):
        """학습이 진행된 순서(미숙 -> 숙련)대로 마일스톤 스냅샷 경로를 반환."""
        return [self.milestone_files[step] for step in sorted(self.milestone_files)]


# ──────────────────────────────────────────────────────────
# 🛠️ [실제 로봇 팔 연동 브릿지 함수]
# ──────────────────────────────────────────────────────────
def send_command_to_real_fr5_robot(action):
    """
    ⚠️ 이 함수는 '실물로 보내지 않는다'. 로그만 남긴다. 의도된 동작이다.

    이유: 로봇 API 명령은 접수 즉시 응답하고 실제 동작 완료를 기다려주지 않는다.
    학습 정책은 스텝당 4mm 델타를 초당 수십 번 쏟아내는데, 이걸 완료 확인 없이
    그대로 스트리밍하면 교육자료 14장에 기록된 실패가 그대로 재현된다
    ("팔이 채 내려가기도 전에 그리퍼가 먼저 닫혀버림").

    실물 실행은 fr5_real_bridge.FR5Bridge 를 통해 '완료 확인이 들어간 웨이포인트
    단위'로 해야 한다. 실행 진입점은 fr5_execute_policy.py 다.
    """
    global _REAL_CMD_COUNT
    _REAL_CMD_COUNT += 1
    if _REAL_CMD_COUNT == 1:
        print("🔌 [실물 연동] 스텝 단위 스트리밍은 안전상 전송하지 않습니다. "
              "실물 실행은 'python3 fr5_execute_policy.py' 를 사용하세요.")


_REAL_CMD_COUNT = 0


# ──────────────────────────────────────────────────────────
# --- 메인 제어 실행부 ---
# ──────────────────────────────────────────────────────────
def step_of(path):
    """모델 파일명에서 학습 스텝 수를 뽑아낸다.

    `candidate_20260908-1215_225000steps.zip` -> 225000
    ⚠ 예전에는 파일명의 **숫자를 전부 이어붙였다**. 파일명에 실행 시각이 들어오면서
      `225000` 과 `202609081215` 가 붙어 버려 엉뚱한 수가 나왔다. `<N>steps` 만 읽는다.
    """
    m = re.search(r"(\d+)steps", os.path.basename(path))
    return int(m.group(1)) if m else None


def load_saved_fleet(save_dir, n_eval_episodes=5):
    """
    [재생 전용 모드] 이미 학습된 모델을 디스크에서 불러온다.
    top-5 는 점수가 저장돼 있지 않으므로 후보들을 짧게 재평가해 순위를 다시 매긴다.
    반환값은 학습 직후와 동일한 형태 (top_paths_best_first, curriculum_steps, curriculum_paths).
    """
    import glob
    # ⚠ "candidate_*steps.zip" 로 잡으면 안 된다 — 파일명 끝에 실행 시각이 붙는다
    #   (candidate_30000steps_20260908-1218.zip). 스텝 수는 step_of() 가 읽는다.
    candidates = sorted(glob.glob(os.path.join(save_dir, "candidate_*.zip")))
    if not candidates:
        raise RuntimeError(
            f"{save_dir} 에 학습된 모델이 없습니다. 재생 전용 모드는 먼저 한 번 학습을 마쳐야 합니다."
        )

    print(f"📂 [재생 전용 모드] 저장된 후보 {len(candidates)}개를 재평가해 순위를 매깁니다...")
    rank_env = Monitor(FR5ScrewAssemblyEnv())
    scored = []
    for path in candidates:
        policy = PPO.load(path, device="cpu")
        mean_reward, std_reward = evaluate_policy(policy, rank_env, n_eval_episodes=n_eval_episodes)
        scored.append((mean_reward, path))
        print(f"   {os.path.basename(path):<32s} 점수 {mean_reward:8.2f} (±{std_reward:.2f})")
    rank_env.close()
    scored.sort(key=lambda item: item[0], reverse=True)
    top_paths = [path for _, path in scored]

    curriculum_dir = os.path.join(save_dir, "curriculum")
    steps, paths = [], []
    for path in sorted(glob.glob(os.path.join(curriculum_dir, "curriculum_*.zip"))):
        n = step_of(path)
        if n is not None:
            steps.append(n)
            paths.append(path)
    order = sorted(range(len(steps)), key=lambda i: steps[i])
    return top_paths, [steps[i] for i in order], [paths[i] for i in order]


if __name__ == "__main__":
    # --replay-only : 학습을 건너뛰고 저장된 모델로 재생 단계만 실행 (녹화/시연용)
    # --steps N     : 재생 스텝 수 변경 (기본 REPLAY_STEPS). 녹화 길이 조절용
    REPLAY_ONLY = "--replay-only" in sys.argv
    if "--steps" in sys.argv:
        REPLAY_STEPS = int(sys.argv[sys.argv.index("--steps") + 1])

    print("🚀 [다중 플릿 제어 시스템] 가상 로봇 4대 + 실제 로봇 1대 리밸런싱 파이프라인 가동...")
    if not MUJOCO_AVAILABLE:
        print("⚠️  mujoco 패키지가 설치되어 있지 않아 시각화는 생략되고, 학습/제어 로직만 동작합니다. "
              "(pip install mujoco)")

    save_dir = "./models_fleet/"
    os.makedirs(save_dir, exist_ok=True)

    if REPLAY_ONLY:
        top_paths, curriculum_steps, curriculum_paths = load_saved_fleet(save_dir)
        topk_callback = None
    else:
        train_env = FR5ScrewAssemblyEnv()
        # 평가 전용 별도 env (학습 env 와 섞이지 않도록 분리, Monitor 로 감싸 에피소드 보상 집계)
        eval_env = Monitor(FR5ScrewAssemblyEnv())
        topk_callback = TopKEvalCallback(
            eval_env=eval_env,
            save_path=save_dir,
            k=5,
            save_freq=25000,
            n_eval_episodes=5,
            milestone_steps=CURRICULUM_STEPS,
            milestone_path=os.path.join(save_dir, "curriculum"),
            verbose=1,
        )

        model = PPO("MlpPolicy", train_env, verbose=0, learning_rate=0.0002, device="cpu")
        print("🏋️ 평가 보상 기준 상위 5개 모델을 실시간 추적하며 250,000 스텝 학습을 개시합니다...")
        model.learn(total_timesteps=250000, callback=topk_callback)
        train_env.close()
        eval_env.close()
        top_paths = topk_callback.get_top_paths_best_first()  # 점수 높은 순으로 정렬됨
        curriculum_paths = topk_callback.get_curriculum_paths()
        curriculum_steps = sorted(topk_callback.milestone_files)

    if len(top_paths) == 0:
        raise RuntimeError("top-5 모델이 하나도 저장되지 않았습니다. save_freq/timesteps 설정을 확인하세요.")
    best_path = top_paths[0]
    print(f"✅ 실제 평가 보상 기준 상위 {len(top_paths)}개 모델 확정!")
    print(f"   ★ 실물 이식 대상(1등): {os.path.basename(best_path)}")

    # ──────────────────────────────────────────────────────────
    # 🎭 재생 로스터 구성
    #   - 양옆: 학습 곡선 구간별 모델 (미숙 -> 숙련 차이가 눈에 보이도록)
    #   - 중앙: 최고 성능 모델 = 나중에 실제 FR5 하드웨어에 이식할 정책
    # ──────────────────────────────────────────────────────────
    if not curriculum_paths:
        # 학습 스텝이 짧아 마일스톤을 못 채운 경우: top 모델로 안전하게 대체
        print("⚠️  마일스톤 스냅샷이 없어 top 모델로 대체합니다.")
        curriculum_paths = top_paths[1:5]
        curriculum_steps = [None] * len(curriculum_paths)

    # 1등 모델의 스텝이 마일스톤과 겹치면 같은 정책이 두 자리에 중복 등장하므로 제외한다
    best_step = step_of(best_path)
    compare_models = []  # [(스텝, 경로), ...] 비교용 커리큘럼 모델
    for step_no, path in zip(curriculum_steps, curriculum_paths):
        if TEST_MODE and step_no is not None and step_no == best_step:
            print(f"   (중복 제외: {step_no // 1000}k 스냅샷은 1등 모델과 동일한 체크포인트)")
            continue
        compare_models.append((step_no, path))

    # 실물 이식 대상이 '정확한 가운데' 자리에 오려면 전체 대수가 홀수여야 한다.
    # 중복 제외로 개수가 홀수가 되면, 아직 쓰지 않은 top 후보 하나를 채워 짝수로 되돌린다.
    if TEST_MODE and len(compare_models) % 2 == 1:
        used = {st for st, _ in compare_models} | {best_step}
        for path in top_paths[1:]:
            st = step_of(path)
            if st is not None and st not in used:
                print(f"   (중앙 정렬 보정: {st // 1000}k 후보를 추가해 총 {len(compare_models) + 2}대로 맞춤)")
                compare_models.append((st, path))
                break
        compare_models.sort(key=lambda item: (item[0] is None, item[0]))

    roster = []  # [(라벨, 모델경로, 실물브릿지여부), ...] — 화면 왼쪽부터의 배치 순서
    for step_no, path in compare_models:
        label = f"{step_no // 1000}k 학습" if step_no else os.path.basename(path)
        roster.append((label, path, False))

    center_idx = None
    if TEST_MODE:
        center_idx = len(roster) // 2  # 정확히 가운데 (전체 홀수 대)
        roster.insert(center_idx, ("★ 실물 이식 대상", best_path, True))

    print("\n🔍 [실시간 동시 검증] 재생 로스터:")
    for i, (label, path, is_real) in enumerate(roster):
        mark = "  <-- 중앙 / 금색 / 실물 SDK 연동" if is_real else ""
        print(f"   {i+1}번 자리: {label:<16s} ({os.path.basename(path)}){mark}")

    envs = [FR5ScrewAssemblyEnv(env_id=i) for i in range(len(roster))]
    models = [PPO.load(path, device="cpu") for _, path, _ in roster]
    observations = [env.reset()[0] for env in envs]

    # 테스트 모드가 아니면 실물 로봇은 화면에 없고 독립 시뮬레이션으로만 돌린다
    offscreen_real_env, offscreen_real_model, offscreen_real_obs = None, None, None
    if not TEST_MODE:
        offscreen_real_model = PPO.load(best_path, device="cpu")
        offscreen_real_env = FR5ScrewAssemblyEnv(env_id=99)
        offscreen_real_obs, _ = offscreen_real_env.reset()

    fleet_viewer = None
    if MUJOCO_AVAILABLE:
        fleet_viewer = FleetViewer(len(roster), resolve_mjcf_path(), highlight_idx=center_idx)
        print(f"\n🏁 [시뮬레이션 시작] 실제 FR5 모델 {len(roster)}대가 한 화면에 "
              f"{FLEET_SPACING}m 간격으로 배치되어 동시 동작합니다.")

    episode_counts = [1] * len(roster)
    success_counts = [0] * len(roster)
    for step in range(REPLAY_STEPS):
        for i, env in enumerate(envs):
            label, _, is_real = roster[i]
            action, _ = models[i].predict(observations[i], deterministic=True)
            observations[i], reward, term, trunc, _ = env.step(action)

            # 중앙 로봇의 행동은 그대로 실제 FR5 하드웨어 인터페이스로 포워딩
            if is_real:
                send_command_to_real_fr5_robot(action)

            if step % 20 == 0:
                dist = np.linalg.norm(env.bullet_casing_pos - observations[i][:3])
                print(f"🖥️ [{label:<16s}] 스텝: {step} | 에피소드: {episode_counts[i]} | "
                      f"Z축 높이: {observations[i][2]:.4f} | 거리오차: {dist:.4f} | "
                      f"누적성공: {success_counts[i]}")

            # 성공/타임아웃 시 즉시 새 에피소드 시작 (멈춰 선 팔을 계속 보여주지 않도록)
            if term or trunc:
                if term:
                    success_counts[i] += 1
                observations[i], _ = env.reset()
                episode_counts[i] += 1

        if not TEST_MODE:
            action, _ = offscreen_real_model.predict(offscreen_real_obs, deterministic=True)
            offscreen_real_obs, _, term, trunc, _ = offscreen_real_env.step(action)
            send_command_to_real_fr5_robot(action)
            if term or trunc:
                offscreen_real_obs, _ = offscreen_real_env.reset()

        # 🖼️ 전체를 한 씬에서 동시 렌더링 (뷰어 창을 닫으면 루프 종료)
        if fleet_viewer is not None:
            ee_local = [env.robot_ee_pos for env in envs]
            casing_local = [env.bullet_casing_pos for env in envs]
            if not fleet_viewer.sync(ee_local, casing_local):
                print("\n🛑 뷰어 창이 닫혀 시뮬레이션을 조기 종료합니다.")
                break
            if step % 20 == 0:
                errs = ", ".join(f"{e:.2f}mm" for e in fleet_viewer.tracking_errors(ee_local))
                print(f"   📐 [IK 추종 오차] {errs}")
                print("-" * 72)

        time.sleep(0.1)

    print(f"\n📊 [최종 집계] {REPLAY_STEPS}스텝 동안의 체결 성공 횟수")
    for i, (label, _, is_real) in enumerate(roster):
        mark = "  <-- 실물 FR5 SDK 로 명령 포워딩됨" if is_real else ""
        print(f"   {label:<16s} : {success_counts[i]:2d}회 성공 "
              f"(에피소드 {episode_counts[i]}회){mark}")

    for env in envs:
        env.close()
    if offscreen_real_env is not None:
        offscreen_real_env.close()
    print("\n🎉 멀티 제어 시뮬레이션 및 실물 하드웨어 이식 예행 연습이 정상 종료되었습니다!")

    if fleet_viewer is not None:
        fleet_viewer.close()
        # MuJoCo 뷰어(GLFW)는 인터프리터 종료 시점에 세그폴트를 내는 환경이 있다.
        # 위 작업이 모두 끝난 뒤이므로, 출력만 비우고 즉시 종료해 잔여 크래시를 피한다.
        sys.stdout.flush()
        os._exit(0)
