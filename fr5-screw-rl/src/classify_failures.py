#
# 🔬 저장된 정책들의 '실패 양상' 분류기
#
# 재생 화면에서 로봇 4대가 똑같이 움직이는 이유는, 전부 같은 학습 실행의
# 수렴 구간 체크포인트여서 정책이 사실상 동일하기 때문이다.
# 발표에서 "여러 실패 양상"을 보여주려면 서로 다른 모드로 실패하는 정책을 골라야 한다.
#
# 에피소드를 굴려 아래 지표를 뽑고 실패 모드를 라벨링한다.
#   · 물림 여부 / 최대 체결깊이      -> 성공·중단 구분
#   · jam(입구 걸림) 발생 횟수       -> 정렬 실패
#   · 결합면까지 최소 접근 거리      -> 접근 자체를 안 하는지
#   · 물림 후 회전량의 합/크기       -> 회전을 안 돌리는지, 거꾸로 푸는지
#
import glob
import os
import sys

import numpy as np
from stable_baselines3 import PPO

import fr5_screw_assembly as E

LABELS = {
    "SUCCESS":   "✅ 체결 성공",
    "WANDER":    "① 접근 실패 — 결합면 근처에 오지도 못하고 배회",
    "JAM":       "② 정렬 실패 — 입구 턱에 걸려 반복 충돌(jam)",
    "HOVER":     "③ 입구 위 호버링 — 정렬은 됐는데 내려가지 않음",
    "NO_SPIN":   "④ 회전 부족 — 물렸지만 축만 밀고 나사를 못 돌림",
    "UNSCREW":   "⑤ 역회전 — 물린 뒤 거꾸로 돌려 다시 풀림",
    "STALL":     "⑥ 체결 중단 — 돌리다 말고 멈춤",
}


def probe(path, n_episodes=12, seed0=3000):
    """한 정책의 실패 양상을 대표 라벨과 지표로 반환."""
    model = PPO.load(path, device="cpu")
    env = E.FR5ScrewAssemblyEnv()
    votes, stats = [], []
    for i in range(n_episodes):
        obs, _ = env.reset(seed=seed0 + i)
        jams, spins, max_depth, min_gap = 0, [], 0.0, 9.9
        engaged_ever = False
        for _ in range(E.MAX_STEPS):
            a, _ = model.predict(obs, deterministic=True)
            obs, _, te, tr, info = env.step(a)
            jams += bool(info["jammed"])
            max_depth = max(max_depth, info["depth_mm"])
            min_gap = min(min_gap, (env.tip_z - E.MOUTH_Z) * 1000.0)
            engaged_ever |= bool(info["engaged"])
            if info["engaged"]:
                spins.append(float(a[5]))
            if te or tr:
                break

        net_spin = float(np.sum(spins)) if spins else 0.0
        abs_spin = float(np.mean(np.abs(spins))) if spins else 0.0
        if info["is_success"]:
            votes.append("SUCCESS")
        elif not engaged_ever:
            if jams >= 15:
                votes.append("JAM")
            elif min_gap < 4.0:
                votes.append("HOVER")
            else:
                votes.append("WANDER")
        elif net_spin <= 0.0:
            votes.append("UNSCREW")
        elif abs_spin < 0.25:
            votes.append("NO_SPIN")
        else:
            votes.append("STALL")
        stats.append((max_depth, jams, min_gap))

    label = max(set(votes), key=votes.count)
    md, jm, gp = np.mean(np.array(stats), axis=0)
    return label, votes.count(label) / n_episodes, md, jm, gp


if __name__ == "__main__":
    dirs = sys.argv[1:] or ["./models_screw/", "./models_screw_1m/"]
    rows = []
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, "**", "*.zip"), recursive=True)):
            label, conf, md, jm, gp = probe(path)
            rows.append((label, path))
            print(f"{os.path.relpath(path):<48s} {LABELS[label]:<38s} "
                  f"(일관성 {conf*100:3.0f}% | 깊이 {md:4.2f}mm | jam {jm:5.1f} | 최소간극 {gp:6.2f}mm)")

    print("\n── 확보된 실패 양상 ──")
    seen = {}
    for label, path in rows:
        seen.setdefault(label, []).append(path)
    for label in LABELS:
        if label in seen:
            print(f"  {LABELS[label]:<40s} {len(seen[label])}개")
    missing = [LABELS[k] for k in LABELS if k not in seen and k != "SUCCESS"]
    if missing:
        print("\n── 아직 없는 양상 ──")
        for m in missing:
            print(f"  {m}")
