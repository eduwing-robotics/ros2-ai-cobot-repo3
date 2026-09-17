#
# 🎥 [녹화용] fr5_multi_fleet_control 의 재생 단계를 오프스크린으로 렌더링해 mp4 로 저장한다.
#
# 기존 데모는 mujoco.viewer.launch_passive(대화형 창)를 쓰므로 녹화가 불가능하다.
# 여기서는 launch_passive 를 더미로 대체하고 FleetViewer 의 씬 구성 로직은 그대로 재사용해
# 아래 3종 앵글을 동시에 뽑는다.
#   - fleet_wide.mp4    : 로봇 5대 전체 조망
#   - fleet_closeup.mp4 : 그리퍼 + 탄두 + 탄피가 모두 들어오는 주 앵글
#   - fleet_macro.mp4   : 탄피 결합면(삽입점) 매크로
# 학습 로직/보상은 전혀 건드리지 않는다.
#
import os
import subprocess
import sys

# OSMesa 백엔드는 PyTorch 와 LLVM 심볼이 충돌해 PPO.load 시점에 세그폴트를 낸다.
# glfw 는 같은 프로세스에서 torch 와 공존하며 오프스크린 렌더도 정상 동작한다.
os.environ.setdefault("MUJOCO_GL", "glfw")

import numpy as np
import mujoco
import mujoco.viewer

import fr5_multi_fleet_control as fc

WIDTH, HEIGHT, FPS = 1280, 720, 20
REPLAY_STEPS = int(sys.argv[sys.argv.index("--steps") + 1]) if "--steps" in sys.argv else 200

# 자세 구속 IK 에서 회전 오차에 곱할 가중치 (m 단위 위치오차와 rad 단위 자세오차의 스케일 정합)
ORI_WEIGHT = 0.10


# ──────────────────────────────────────────────────────────
# 대화형 뷰어를 더미로 대체 (씬 구성은 원본 그대로 사용)
# ──────────────────────────────────────────────────────────
class _DummyViewer:
    def is_running(self):
        return True

    def sync(self):
        return None

    def close(self):
        return None


mujoco.viewer.launch_passive = lambda model, data, **kw: _DummyViewer()


class RecordingFleetViewer(fc.FleetViewer):
    """오프스크린 해상도 주입 + 자세까지 구속하는 6자유도 IK."""

    def _build_fleet_xml(self, mjcf_path):
        path = super()._build_fleet_xml(mjcf_path)
        xml = open(path, encoding="utf-8").read()
        if "offwidth" not in xml:
            xml = xml.replace(
                "<worldbody>",
                f'<visual><global offwidth="{WIDTH}" offheight="{HEIGHT}"/></visual>\n<worldbody>',
                1,
            )
            open(path, "w", encoding="utf-8").write(xml)
        return path

    def _solve_ik(self, robot_idx, target_pos, max_iters=80, tol=1e-4,
                  step_gain=0.5, damping=1e-3):
        """
        원본 IK 는 위치 3자유도만 풀어 손목 자세가 자유롭게 굴러다녔다.
        그 결과 그리퍼에 물린 탄두가 옆으로 누워 탄피와 동축이 되지 않았으므로,
        툴 z축을 연직 하향(0,0,-1)으로 고정하는 자세 구속을 함께 푼다.
        """
        site_id = self.site_ids[robot_idx]
        dofs, qadr = self.arm_dofs[robot_idx], self.arm_qpos[robot_idx]

        q_des = np.zeros(4)
        mujoco.mju_mat2Quat(q_des, np.array([1., 0, 0, 0, -1., 0, 0, 0, -1.]))
        jacp, jacr = np.zeros((3, self.model.nv)), np.zeros((3, self.model.nv))
        q_cur, q_inv, q_err, w = (np.zeros(4), np.zeros(4), np.zeros(4), np.zeros(3))

        for _ in range(max_iters):
            mujoco.mj_forward(self.model, self.data)
            err_pos = target_pos - self.data.site_xpos[site_id]

            mujoco.mju_mat2Quat(q_cur, self.data.site_xmat[site_id])
            mujoco.mju_negQuat(q_inv, q_cur)
            mujoco.mju_mulQuat(q_err, q_des, q_inv)
            mujoco.mju_quat2Vel(w, q_err, 1.0)

            err = np.concatenate([err_pos, w * ORI_WEIGHT])
            if np.linalg.norm(err) < tol:
                break

            mujoco.mj_jacSite(self.model, self.data, jacp, jacr, site_id)
            jac = np.vstack([jacp[:, dofs], jacr[:, dofs] * ORI_WEIGHT])
            dq = jac.T @ np.linalg.solve(jac @ jac.T + damping * np.eye(6), err)
            self.data.qpos[qadr] = np.clip(
                self.data.qpos[qadr] + dq * step_gain, self.jnt_lo[qadr], self.jnt_hi[qadr]
            )


def make_writer(path):
    """ffmpeg 로 rawvideo 프레임을 받아 mp4 로 인코딩."""
    return subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", path],
        stdin=subprocess.PIPE,
    )


def build_roster():
    """원본 __main__ 과 동일한 규칙으로 재생 로스터를 구성."""
    top_paths, curriculum_steps, curriculum_paths = fc.load_saved_fleet("./models_fleet/")
    best_path = top_paths[0]
    if not curriculum_paths:
        curriculum_paths, curriculum_steps = top_paths[1:5], [None] * 4

    best_step = fc.step_of(best_path)
    compare = [(s, p) for s, p in zip(curriculum_steps, curriculum_paths)
               if not (fc.TEST_MODE and s is not None and s == best_step)]
    if fc.TEST_MODE and len(compare) % 2 == 1:
        used = {s for s, _ in compare} | {best_step}
        for p in top_paths[1:]:
            s = fc.step_of(p)
            if s is not None and s not in used:
                compare.append((s, p))
                break
        compare.sort(key=lambda it: (it[0] is None, it[0]))

    roster = [(f"{s // 1000}k 학습" if s else os.path.basename(p), p, False) for s, p in compare]
    center_idx = None
    if fc.TEST_MODE:
        center_idx = len(roster) // 2
        roster.insert(center_idx, ("★ 실물 이식 대상", best_path, True))
    return roster, center_idx


def main():
    roster, center_idx = build_roster()
    print("\n🎬 [녹화 로스터]")
    for i, (label, path, is_real) in enumerate(roster):
        print(f"   {i+1}번 자리: {label:<16s} ({os.path.basename(path)})"
              f"{'  <-- 중앙/금색' if is_real else ''}")

    from stable_baselines3 import PPO
    envs = [fc.FR5ScrewAssemblyEnv(env_id=i) for i in range(len(roster))]
    models = [PPO.load(p, device="cpu") for _, p, _ in roster]
    obs = [e.reset()[0] for e in envs]

    viewer = RecordingFleetViewer(len(roster), fc.resolve_mjcf_path(), highlight_idx=center_idx)
    renderer = mujoco.Renderer(viewer.model, HEIGHT, WIDTH)
    # 기본 headlight 만으로는 어두워 부품 형상이 묻힌다
    viewer.model.vis.headlight.ambient[:] = 0.50
    viewer.model.vis.headlight.diffuse[:] = 0.80

    c = center_idx if center_idx is not None else 0
    casing = viewer.base_offsets[c] + fc.TASK_FRAME_ORIGIN + envs[c].bullet_casing_pos

    # (파일명, lookat, distance, azimuth, elevation)
    #   closeup/macro 앵글은 후보를 실제로 렌더해 비교한 뒤 고른 값이다.
    #   azimuth 215° 는 팔이 부품 뒤로 빠지는 방향이라 그리퍼-탄두-탄피가 가려지지 않는다.
    cam_specs = [
        ("fleet_wide.mp4",
         np.array([fc.TASK_FRAME_ORIGIN[0] * 0.5, 0.0, 0.45]),
         max(4.2, len(roster) * fc.FLEET_SPACING * 0.88), 150, -12),
        ("fleet_closeup.mp4", casing + np.array([0, 0, 0.040]), 0.26, 215, -14),
        ("fleet_macro.mp4",   casing + np.array([0, 0, 0.030]), 0.15, 205, -6),
    ]

    cams, writers = [], []
    for path, lookat, dist, az, el in cam_specs:
        cam = mujoco.MjvCamera()
        cam.lookat[:] = lookat
        cam.distance, cam.azimuth, cam.elevation = dist, az, el
        cams.append(cam)
        writers.append(make_writer(path))

    success_counts, episode_counts = [0] * len(roster), [1] * len(roster)
    print(f"\n🏁 {len(roster)}대 동시 재생 + 녹화 시작 ({REPLAY_STEPS} 스텝, 앵글 {len(cams)}종)")
    for step in range(REPLAY_STEPS):
        for i, env in enumerate(envs):
            action, _ = models[i].predict(obs[i], deterministic=True)
            obs[i], _, term, trunc, _ = env.step(action)
            if term or trunc:
                if term:
                    success_counts[i] += 1
                obs[i], _ = env.reset()
                episode_counts[i] += 1

        viewer.sync([e.robot_ee_pos for e in envs], [e.bullet_casing_pos for e in envs])
        for cam, writer in zip(cams, writers):
            renderer.update_scene(viewer.data, cam)
            writer.stdin.write(renderer.render().tobytes())

        if step % 40 == 0:
            errs = ", ".join(f"{e:.2f}mm" for e in
                             viewer.tracking_errors([e.robot_ee_pos for e in envs]))
            zax = viewer.data.site_xmat[viewer.site_ids[c]].reshape(3, 3)[:, 2]
            tilt = np.degrees(np.arccos(np.clip(-zax[2], -1, 1)))
            print(f"   스텝 {step:3d} | IK 위치오차 {errs} | 툴 자세편차 {tilt:.2f}°")

    for writer in writers:
        writer.stdin.close()
        writer.wait()

    print("\n📊 [집계] 체결 성공 횟수")
    for i, (label, _, _) in enumerate(roster):
        print(f"   {label:<16s} : {success_counts[i]:2d}회 (에피소드 {episode_counts[i]}회)")
    print("\n🎉 녹화 완료: " + " / ".join(spec[0] for spec in cam_specs))


if __name__ == "__main__":
    main()
