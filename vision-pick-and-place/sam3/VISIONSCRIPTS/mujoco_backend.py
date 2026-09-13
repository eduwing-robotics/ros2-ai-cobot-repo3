#!/usr/bin/env python3
"""FR5 MuJoCo 백엔드 — 실제 로봇 대신 시뮬레이터로 궤적을 확인한다.

sam3_pick_ros2.py 의 --sim 에서 쓴다. 실제 로봇을 켜기 전에
"이 좌표로 팔이 안전하게 가는가"를 눈으로 보는 용도다.

한계 (반드시 알고 쓸 것)
  - 위치만 역기구학으로 푼다. 자세(RX/RY/RZ)는 시뮬레이션하지 않는다.
    FR5의 오일러 각 규약이 확인되지 않아, 틀린 자세를 맞다고 보여주느니 빼는 편을 택했다.
  - 시뮬레이터에 탄두·탄피가 없다. 인식은 실제 카메라를 그대로 쓴다.
  - 충돌 검사는 MuJoCo 기본 접촉만 본다. 실제 작업물·지그는 모델에 없다.
"""
import os, time
import numpy as np
import mujoco

MODEL_PATH = os.path.expanduser("~/fr5_mujoco/fr5.xml")
SCENE_PATH = os.path.expanduser("~/fr5_mujoco/fr5_scene.xml")   # 작업대·물체·손목카메라 포함
ARM_DOF = 6                      # j1~j6
GRIP_JOINTS = (6, 7)             # finger_right_joint, finger_left_joint


class MujocoBackend:
    def __init__(self, model_path=MODEL_PATH, viewer=True, step_time=0.6, physics=False):
        self.m = mujoco.MjModel.from_xml_path(model_path)
        self.d = mujoco.MjData(self.m)
        mujoco.mj_forward(self.m, self.d)
        self.bid_r = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_BODY, "finger_tip_right_link")
        self.bid_l = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_BODY, "finger_tip_left_link")
        self.bid_w = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_BODY, "wrist3_link")
        self.step_time = step_time
        self.physics = physics      # True 면 mj_step 으로 실제 구동한다(접촉·파지가 일어난다)
        if physics:
            self.d.ctrl[:ARM_DOF] = self.d.qpos[:ARM_DOF]
            self.d.ctrl[ARM_DOF]  = self.d.qpos[GRIP_JOINTS[0]]
        self.v = None
        if viewer:
            from mujoco import viewer as mj_viewer    # 함수 안 import는 mujoco를 지역변수로 만든다
            self.v = mj_viewer.launch_passive(self.m, self.d)
            print("[sim] MuJoCo 뷰어 실행. 창을 닫으면 시뮬레이션도 끝난다.")

    # ---------- 상태 ----------
    def tcp_mm(self):
        """양쪽 손가락 끝 중점을 TCP로 본다. 단위 mm."""
        mujoco.mj_forward(self.m, self.d)
        p = (self.d.xpos[self.bid_r] + self.d.xpos[self.bid_l]) / 2.0
        return p * 1000.0

    def _tcp_jac(self):
        """TCP(손가락 중점)의 위치 야코비안 3xnv."""
        jr = np.zeros((3, self.m.nv)); jl = np.zeros((3, self.m.nv))
        mujoco.mj_jacBody(self.m, self.d, jr, None, self.bid_r)
        mujoco.mj_jacBody(self.m, self.d, jl, None, self.bid_l)
        return (jr + jl) / 2.0

    def _tool_axis(self):
        """그리퍼가 향하는 방향 = wrist3_link 의 +Z 축 (월드 기준)."""
        return self.d.xmat[self.bid_w].reshape(3,3)[:, 2]

    def _rot_jac(self):
        jrot = np.zeros((3, self.m.nv))
        mujoco.mj_jacBody(self.m, self.d, None, jrot, self.bid_w)
        return jrot

    @staticmethod
    def _skew(v):
        return np.array([[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]])

    @staticmethod
    def _axis_err(a, a_des):
        """a 를 a_des 로 돌리는 회전벡터(축*각도).
        선형 차 (a_des - a) 를 쓰면 두 축이 정반대일 때 회전으로 바뀌지 않아 잠긴다.
        정반대면 임의의 수직축을 골라 빠져나온다."""
        c = np.cross(a, a_des); n = np.linalg.norm(c); dot = float(np.dot(a, a_des))
        if n < 1e-8:
            if dot > 0: return np.zeros(3)
            c = np.cross(a, np.array([1.0, 0.0, 0.0]))
            if np.linalg.norm(c) < 1e-8: c = np.cross(a, np.array([0.0, 1.0, 0.0]))
            return c / np.linalg.norm(c) * np.pi
        return c / n * float(np.arctan2(n, dot))

    # ---------- 역기구학 ----------
    def solve_ik(self, target_mm, iters=500, tol_mm=0.5, damping=1e-2, max_dq=0.15,
                 down=True, w_rot=0.2):   # w_rot 0.6 이상이면 자세와 위치가 다투다 수렴 실패
        """감쇠 최소자승(DLS) 반복 역기구학.
        위치 3자유도 + (down=True면) 공구축을 아래로 향하게 하는 2자유도를 같이 푼다.
        위치만 풀면 그리퍼 자세가 제멋대로가 되어 손목 카메라가 엉뚱한 곳을 본다.
        관절 리밋을 매 스텝 클램프하므로 j6의 0.021 상한도 지켜진다."""
        target = np.asarray(target_mm, dtype=float) / 1000.0
        a_des = np.array([0.0, 0.0, -1.0])      # 월드 -Z = 아래
        q0 = self.d.qpos.copy()
        for _ in range(iters):
            mujoco.mj_forward(self.m, self.d)
            cur = (self.d.xpos[self.bid_r] + self.d.xpos[self.bid_l]) / 2.0
            e_pos = target - cur
            if down:
                a = self._tool_axis()
                e_rot = self._axis_err(a, a_des)
                ok = (np.linalg.norm(e_pos)*1000.0 < tol_mm) and (np.linalg.norm(e_rot) < 0.02)
            else:
                e_rot = np.zeros(3); ok = np.linalg.norm(e_pos)*1000.0 < tol_mm
            if ok:
                return self.d.qpos[:ARM_DOF].copy(), np.linalg.norm(e_pos)*1000.0
            Jp = self._tcp_jac()[:, :ARM_DOF]
            if down:
                Jr = self._rot_jac()[:, :ARM_DOF]          # 회전벡터 오차에는 각속도 야코비안을 그대로 쓴다
                J = np.vstack([Jp, w_rot*Jr]); err = np.concatenate([e_pos, w_rot*e_rot])
            else:
                J = Jp; err = e_pos
            dq = J.T @ np.linalg.solve(J @ J.T + damping*np.eye(J.shape[0]), err)
            n = np.linalg.norm(dq)
            if n > max_dq: dq = dq / n * max_dq
            q = self.d.qpos[:ARM_DOF] + dq
            lo, hi = self.m.jnt_range[:ARM_DOF, 0], self.m.jnt_range[:ARM_DOF, 1]
            self.d.qpos[:ARM_DOF] = np.clip(q, lo, hi)
        mujoco.mj_forward(self.m, self.d)
        cur = (self.d.xpos[self.bid_r] + self.d.xpos[self.bid_l]) / 2.0
        resid = np.linalg.norm(target - cur) * 1000.0
        self.d.qpos[:] = q0                      # 실패하면 원래 자세로 되돌린다
        mujoco.mj_forward(self.m, self.d)
        return None, resid

    # ---------- 동작 ----------
    def _sync(self):
        if self.v is not None:
            if not self.v.is_running(): raise KeyboardInterrupt("뷰어가 닫혔습니다")
            self.v.sync()

    def move_to(self, x_mm, y_mm, z_mm, tol_mm=0.5):
        """목표 위치로 이동. physics=True 면 액추에이터로 실제 구동한다."""
        q_start = self.d.qpos[:ARM_DOF].copy()
        q_save  = self.d.qpos.copy()
        q_goal, resid = self.solve_ik((x_mm, y_mm, z_mm), tol_mm=tol_mm)
        if q_goal is None:
            print(f"    [sim] 역기구학 실패 — 목표까지 {resid:.1f}mm 남음. 이동하지 않는다")
            return False
        if not self.physics:
            steps = max(10, int(self.step_time / 0.02))
            for i in range(steps + 1):
                self.d.qpos[:ARM_DOF] = q_start + (q_goal - q_start) * (i / steps)
                mujoco.mj_forward(self.m, self.d); self._sync(); time.sleep(0.02)
            return True
        # 물리 모드: IK 로 자세만 계산하고 상태는 되돌린 뒤, ctrl 을 보간해 실제로 구동한다
        self.d.qpos[:] = q_save; mujoco.mj_forward(self.m, self.d)
        nstep = max(1, int(self.step_time / self.m.opt.timestep))
        for i in range(nstep):
            self.d.ctrl[:ARM_DOF] = q_start + (q_goal - q_start) * ((i+1) / nstep)
            mujoco.mj_step(self.m, self.d)
            if i % 10 == 0: self._sync()
        for _ in range(int(0.3 / self.m.opt.timestep)):   # 정착
            mujoco.mj_step(self.m, self.d)
        self._sync()
        return True

    def gripper(self, pos_0_100, settle=0.6):
        """0=완전 닫힘, 100=완전 열림. 실제 로봇 규약과 맞춘다."""
        hi = self.m.jnt_range[GRIP_JOINTS[0], 1]
        val = float(np.clip(pos_0_100, 0, 100)) / 100.0 * hi
        if not self.physics:
            q0 = self.d.qpos[GRIP_JOINTS[0]]
            for i in range(21):
                v = q0 + (val - q0) * (i / 20)
                for j in GRIP_JOINTS: self.d.qpos[j] = v
                mujoco.mj_forward(self.m, self.d); self._sync(); time.sleep(0.02)
            return
        c0 = float(self.d.ctrl[ARM_DOF])
        nstep = max(1, int(settle / self.m.opt.timestep))
        for i in range(nstep):
            self.d.ctrl[ARM_DOF] = c0 + (val - c0) * ((i+1) / nstep)
            mujoco.mj_step(self.m, self.d)
            if i % 10 == 0: self._sync()
        self._sync()

    def grasped(self, body_name, max_gap_mm=25.0):
        """물체가 손가락 사이에 잡혀 있는지 대략 판정한다."""
        bid = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_BODY, body_name)
        if bid < 0: return False
        mujoco.mj_forward(self.m, self.d)
        tcp = (self.d.xpos[self.bid_r] + self.d.xpos[self.bid_l]) / 2.0
        return float(np.linalg.norm(self.d.xpos[bid] - tcp)) * 1000.0 < max_gap_mm

    def close(self):
        if self.v is not None:
            try: self.v.close()
            except Exception: pass


if __name__ == "__main__":
    # 단독 실행: 홈 포즈에서 TCP를 읽고 조금 움직여 본다
    b = MujocoBackend()
    p = b.tcp_mm()
    print(f"홈 포즈 TCP: x={p[0]:.1f} y={p[1]:.1f} z={p[2]:.1f} mm")
    for d in ((0,0,50), (30,0,0), (0,30,0), (0,0,-50), (-30,-30,0)):
        t = b.tcp_mm() + np.array(d)
        ok = b.move_to(*t)
        q = b.tcp_mm()
        print(f"  목표 {t.round(1)} → {'도달' if ok else '실패'}  실제 {q.round(1)}")
    time.sleep(1.0); b.close()
