#
# 📈 학습 진행에 따른 '문지름(jam)' 추이 리포트
#
# 목적: 학습이 진행될수록 결합면을 문지르는 동작이 늘어나지 않는지 확인한다.
# 고정 페널티 시절에는 25만 스텝 11회 -> 30만 스텝 63회로 오히려 늘어났다.
#
import glob
import os
import re
import sys

import numpy as np
from stable_baselines3 import PPO

import fr5_screw_assembly as E


def measure(path, n_episodes=20, seed0=5000):
    model = PPO.load(path, device="cpu")
    env = E.FR5ScrewAssemblyEnv()
    succ, jams, depths = 0, [], []
    for i in range(n_episodes):
        obs, _ = env.reset(seed=seed0 + i)
        for _ in range(E.MAX_STEPS):
            a, _ = model.predict(obs, deterministic=True)
            obs, _, te, tr, info = env.step(a)
            if te or tr:
                break
        succ += bool(info["is_success"])
        jams.append(info["jam_steps"])
        depths.append(info["depth_mm"])
    return succ / n_episodes, float(np.mean(jams)), float(np.mean(depths))


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "./models_screw/"

    def step_of(p):
        # ⚠ 숫자를 이어붙이면 안 된다 — 파일명 끝에 실행 시각이 붙는다
        #   (candidate_250000steps_20260908-1221.zip). `<N>steps` 만 읽는다.
        m = re.search(r"(\d+)steps", os.path.basename(p))
        digits = m.group(1) if m else ""
        return int(digits) if digits else 0

    paths = sorted(glob.glob(os.path.join(d, "**", "*.zip"), recursive=True), key=step_of)
    print(f"{'체크포인트':<34s} {'성공률':>7s} {'문지름':>9s} {'체결깊이':>9s}")
    print("-" * 64)
    prev = None
    for p in paths:
        sr, jm, dp = measure(p)
        arrow = ""
        if prev is not None:
            arrow = " ↑ 증가" if jm > prev + 2 else (" ↓ 감소" if jm < prev - 2 else " = 유지")
        prev = jm
        print(f"{os.path.relpath(p, d):<34s} {sr*100:6.1f}% {jm:8.1f}회 {dp:8.2f}mm{arrow}")
