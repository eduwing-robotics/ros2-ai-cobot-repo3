#
# 🔍 학습 결과 검증 — MuJoCo 창을 띄워 실제 동작을 보면서 값을 출력한다
#
# 학습(train_screw_ppo.py) 과 녹화(record_screw_video.py) 사이에 넣는 단계다.
# 녹화는 오프스크린이라 화면에 아무것도 안 뜬다. 여기서는 실제 MuJoCo 창을 열어
# 로봇이 도는 것을 보면서, 매 스텝의 상태값을 터미널에 함께 찍는다.
#
# 흐름
#   1. train_screw_ppo.py      학습 (PPO 로그 출력)
#   2. verify_screw_policy.py  ← 여기. 창 띄우고 값 출력
#   3. record_screw_video.py   녹화
#
# 사용
#   python3 verify_screw_policy.py                    # 5대 전체, 실시간 속도
#   python3 verify_screw_policy.py --robot best       # 최고 성능 1대만
#   python3 verify_screw_policy.py --speed 2          # 2배속
#   python3 verify_screw_policy.py --steps 400
#
import os
import sys
import time

import numpy as np
import mujoco
import mujoco.viewer

import fr5_multi_fleet_control as fc
import fr5_screw_assembly as E
import record_screw_video as R


def fmt_state(env, step):
    """한 스텝의 상태를 사람이 읽는 한 줄로."""
    if not env.engaged:
        phase = "접근" if env.tip_z > E.MOUTH_Z else "입구 걸림"
        return (f"[{step:3d}] {phase:<9s} 선단높이 {(env.tip_z-E.MOUTH_Z)*1000:+6.2f}mm | "
                f"편심 {env.lateral*1000:5.2f}mm | 기울기 {np.degrees(env.tilt):4.1f}°")
    return (f"[{step:3d}] 체결 중     깊이 {env.depth*1000:5.2f}/{E.SEAT_DEPTH*1000:.2f}mm | "
            f"회전 {np.degrees(env.spin):6.0f}° | 손목 {np.degrees(env.wrist):+6.1f}° | "
            f"재파지 {env.regrips}회")


def main():
    a = sys.argv
    steps = int(a[a.index("--steps") + 1]) if "--steps" in a else 320
    speed = float(a[a.index("--speed") + 1]) if "--speed" in a else 1.0
    only_best = "--robot" in a and a[a.index("--robot") + 1] == "best"
    every = int(a[a.index("--every") + 1]) if "--every" in a else 10

    print("═" * 74)
    print("🔍 [검증] 학습된 정책을 MuJoCo 창에서 실행하며 값 확인")
    print("═" * 74)

    roster, center_idx = R.build_roster()
    if only_best:
        roster = [roster[center_idx]]
        center_idx = 0
        print("\n중앙(최고 성능) 로봇 1대만 표시합니다.")

    print("\n🎬 [배치]")
    for i, (label, path, is_best, _) in enumerate(roster):
        import os
        print(f"   {i+1}번 자리: {label:<16s} ({os.path.basename(path)})"
              f"{'  <-- 금색 / 실물 이식 대상' if is_best else ''}")

    from stable_baselines3 import PPO
    envs = [cls(env_id=i) for i, (_, _, _, cls) in enumerate(roster)]
    models = [PPO.load(p, device="cpu") for _, p, _, _ in roster]
    obs = [e.reset()[0] for e in envs]

    print("\n🖥️  MuJoCo 창을 엽니다. 창을 닫으면 검증이 종료됩니다.")
    viewer = R.ScrewFleetViewer(len(roster), fc.resolve_mjcf_path(),
                                highlight_idx=center_idx)
    # [2026-09-16] 0.50 / 0.80 에서 낮췄다. 그 값에서는 책상이 252.8/255 로
    #   **거의 완전 포화**해 형상 정보가 사라졌다 — 고정대가 책상에 녹아 보이지 않고
    #   구멍도 식별되지 않았으며, 눈이 부셨다. 색(MJCF)은 건드리지 않고 조명만 낮춘다.
    #   ⚠ 2026-09-08 에 책상 색을 어둡게 바꿨다가 되돌린 적이 있다. 색이 아니라
    #     **노출이 문제**였다. 같은 이유로 색을 다시 만지지 마라.
    viewer.model.vis.headlight.ambient[:] = 0.32
    viewer.model.vis.headlight.diffuse[:] = 0.58

    # ── 카메라 — record_screw_video.py 의 '전체 조망' 확정 구도와 같은 값이다. ──
    # 지정하지 않으면 MuJoCo 기본 자유카메라(dist 5.25 / az 90 / el -45)로 떠서
    # 5.25m 위에서 내려다보는, 영상과 전혀 다른 화면이 나온다. 매번 마우스로
    # 끌어 맞추지 않도록 상수로 박는다.
    #   ⚠ 값을 바꾸려면 record_screw_video.py 의 screw_wide.mp4 스펙과 함께 바꿔라.
    #     따로 놀면 창에서 본 구도와 녹화된 영상이 어긋난다.
    CAM_LOOKAT    = [fc.TASK_FRAME_ORIGIN[0], -1.2, 0.6]
    CAM_DISTANCE  = 2.77
    CAM_AZIMUTH   = 60.0
    CAM_ELEVATION = -11.0
    cam = viewer.viewer.cam
    cam.lookat[:] = CAM_LOOKAT
    cam.distance, cam.azimuth, cam.elevation = CAM_DISTANCE, CAM_AZIMUTH, CAM_ELEVATION

    c = center_idx
    dt = E.CONTROL_DT / max(speed, 0.01)
    print(f"   재생 속도 {speed:.1f}배 (스텝당 {dt*1000:.0f}ms, "
          f"체결 회전 {np.degrees(E.SPIN_SCALE/E.CONTROL_DT)*speed:.0f}°/s)\n")

    # 재파지 연출. j6 는 한 스트로크에 344°(±172°, 하드 ±175 에서 여유 3°) 밖에 못 돌아
    # 하는데, 되감기를 1스텝에 처리하면 화면에서 연속 회전처럼 보인다.
    RG_OPEN, RG_TURN, RG_CLOSE = 2, 8, 2
    RG_TOTAL = RG_OPEN + RG_TURN + RG_CLOSE
    regrip_t = [0] * len(roster)
    rwrist = [e.wrist for e in envs]
    fingers = [False] * len(roster)

    succ = [0] * len(roster)
    prev_regrips = [0] * len(roster)
    prev_pose = None
    FRAME_DT = 1.0 / 30.0        # 30fps 로 그린다 — 한 스텝을 이 간격으로 나눈다
    done_at = None

    try:
        for step in range(steps):
            if not viewer.viewer.is_running():
                print("\n🛑 창이 닫혀 검증을 종료합니다.")
                break
            t0 = time.time()

            for i, env in enumerate(envs):
                if regrip_t[i] > 0:
                    # 재파지 연출 중에는 정책을 진행시키지 않는다
                    t = RG_TOTAL - regrip_t[i] + 1
                    if t <= RG_OPEN:
                        rwrist[i] = E.WRIST_LIMIT
                    elif t <= RG_OPEN + RG_TURN:
                        u = (t - RG_OPEN) / RG_TURN
                        rwrist[i] = E.WRIST_LIMIT + (-2 * E.WRIST_LIMIT) * u
                    else:
                        rwrist[i] = -E.WRIST_LIMIT
                    fingers[i] = t <= RG_OPEN + RG_TURN
                    regrip_t[i] -= 1
                    if regrip_t[i] == 0:
                        fingers[i] = False
                    continue

                act, _ = models[i].predict(obs[i], deterministic=True)
                obs[i], _, te, tr, info = env.step(act)
                rwrist[i] = env.wrist
                if info["regrips"] > prev_regrips[i]:
                    prev_regrips[i] = info["regrips"]
                    regrip_t[i] = RG_TOTAL
                    rwrist[i] = E.WRIST_LIMIT
                    if i == c:
                        print(f"      ↺ 재파지 {info['regrips']}회 — 그리퍼 열고 "
                              f"손목 {np.degrees(E.WRIST_LIMIT):+.0f}° → "
                              f"{np.degrees(-E.WRIST_LIMIT):+.0f}° 되감음 "
                              f"(한 스트로크 {2*np.degrees(E.WRIST_LIMIT):.0f}°)")
                if te or tr:
                    if info["is_success"]:
                        succ[i] += 1
                        if i == c and done_at is None:
                            done_at = step
                            print(f"\n🎉 [체결 완료] {step}스텝 ({step*E.CONTROL_DT:.1f}초) | "
                                  f"깊이 {info['depth_mm']:.2f}mm | "
                                  f"재파지 {info['regrips']}회 | "
                                  f"문지름 {info['jam_steps']}스텝\n")
                    obs[i], _ = env.reset()
                    prev_regrips[i] = 0
                    regrip_t[i] = 0
                    rwrist[i] = env.wrist

            # ── 스텝 사이를 보간해 그린다 ────────────────────────────────
            # ⚠ 한 정책 스텝은 실기의 한 칸(34.4°)이고, 실시간으로는 6초 걸린다.
            #   전에는 그 6초를 통째로 쉬고 한 번만 그려서 **34.4° 확 돌고 멈추는** 식으로
            #   보였다. 물리 문제가 아니라 그리기 문제다. 스텝 사이를 나눠 그리면
            #   실물처럼 이어져 돈다. 물리는 손대지 않는다 — 자세를 섞어 그릴 뿐이다.
            pose = ([e.robot_ee_pos.copy() for e in envs],
                    [R.tool_quat(e.tool_tilt, 0.0) for e in envs],
                    [e.bullet_casing_pos.copy() for e in envs],
                    list(fingers), list(rwrist))
            if prev_pose is None:
                prev_pose = pose
            nf = max(1, int(dt / FRAME_DT))          # 이 스텝을 몇 프레임에 나눠 그릴까
            for f in range(1, nf + 1):
                a = f / nf
                viewer.sync_pose(
                    [p0 + (p1 - p0) * a for p0, p1 in zip(prev_pose[0], pose[0])],
                    pose[1],
                    [c0 + (c1 - c0) * a for c0, c1 in zip(prev_pose[2], pose[2])],
                    finger_open=[g0 + (g1 - g0) * a for g0, g1 in zip(prev_pose[3], pose[3])],
                    wrist=[w0 + (w1 - w0) * a for w0, w1 in zip(prev_pose[4], pose[4])])
                viewer.viewer.sync()
                want = t0 + dt * a
                lag = want - time.time()
                if lag > 0:
                    time.sleep(lag)
            prev_pose = pose

            if step % every == 0:
                print(fmt_state(envs[c], step))
    finally:
        viewer.close()

    print("\n" + "─" * 74)
    print("📊 [검증 결과]")
    for i, (label, _, _, _) in enumerate(roster):
        print(f"   {label:<16s} : 체결 성공 {succ[i]}회")
    if done_at is not None:
        print(f"\n✅ 중앙 로봇이 {done_at*E.CONTROL_DT:.1f}초 만에 나사부 {E.THREAD_DEPTH*1000:.2f}mm 를 "
              f"끝까지 체결했습니다.")
    print("\n다음 단계: python3 record_screw_video.py --models ./models_screw/")

    # MuJoCo 대화형 뷰어(GLFW)는 인터프리터 종료 시점에 세그폴트를 내는 환경이 있다.
    # 할 일은 모두 끝났으므로 출력만 비우고 즉시 종료해 잔여 크래시를 피한다.
    # (fr5_multi_fleet_control.py 도 같은 방식을 쓴다)
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
