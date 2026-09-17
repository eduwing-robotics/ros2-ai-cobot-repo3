#
# 🏋️ 실측 기반 나사 체결 환경(fr5_screw_assembly) PPO 학습
#
# 저장 규칙은 기존 파이프라인과 동일하게 맞춰 재생/녹화 쪽에서 그대로 쓸 수 있게 한다.
#   models_screw/candidate_<step>steps.zip            : 비교·평가용 스냅샷
#   models_screw/curriculum/curriculum_<step>steps.zip: 학습 곡선 비교용 마일스톤
#
import os
import sys
import time

import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.env_util import make_vec_env
from stable_baselines3.common.logger import configure
from stable_baselines3.common.monitor import Monitor

from fr5_screw_assembly import FR5ScrewAssemblyEnv, MAX_STEPS
import docs_guard                          # noqa: E402

docs_guard.ensure()   # 치수·설정이 바뀌었으면 문서를 다시 만든다
import fr5_screw_assembly as E   # 성공 기준 깊이(SEAT_DEPTH)를 출력에 쓴다

SAVE_DIR   = "./models_screw/"


# 학습을 돌릴 때마다 로그를 새 폴더에 남긴다. 이전 기록은 절대 덮어쓰지 않는다.
#   train_runs/20260901_1507/log.txt
#                            /progress.csv
#                            /models/       그 학습의 스냅샷 사본
# models_screw/ 바깥에 두는 이유: record_screw_video.py 가 models_screw/**/*.zip 를
# 재귀 검색해 후보를 고르기 때문에, 안에 두면 옛 학습 모델까지 후보로 딸려 들어온다.
# 사용자 요청 (2026-09-01): "학습로그들은 그때그시간으로 날짜로 계속 남겨.
#                            이전꺼 지우지 말고"
#                           "강화학습하면 모두 남기는 거야 그때마다"
LOG_ROOT   = "./train_runs/"


def _new_run_dir():
    """학습을 돌릴 때마다 새 폴더를 만든다. 기존 폴더는 절대 건드리지 않는다."""
    os.makedirs(LOG_ROOT, exist_ok=True)
    base = time.strftime("%Y%m%d_%H%M")
    stamp, n = base, 2
    while os.path.exists(os.path.join(LOG_ROOT, stamp)):   # 같은 분에 두 번 돌린 경우
        stamp, n = f"{base}_{n}", n + 1
    return stamp


RUN_STAMP  = _new_run_dir()
LOG_DIR    = os.path.join(LOG_ROOT, RUN_STAMP) + os.sep
# 스냅샷 파일명에 **실행 시각**을 넣는다 (2026-09-08).
#   candidate_<스텝>steps_<시각>.zip
# ⚠ 예전에는 스텝 수만 썼다. 두 번째 실행이 같은 지점을 지나면 첫 실행의 스냅샷을
#   **덮어써서**, 공용 폴더에는 "가장 최근 학습" 것만 남았다. 어느 실행의 정책인지
#   구분할 수 없었다.
# ⚠ 뒤에 붙이므로 파일을 찾는 쪽 glob 이 "candidate_*.zip" 이어야 한다
#   (fr5_multi_fleet_control.load_saved_fleet). 스텝 수는 step_of() 가 정규식으로 읽는다.
STAMP      = RUN_STAMP.strip(os.sep).replace("_", "-")
MILESTONES = [25_000, 100_000, 250_000]        # 미숙 -> 숙련 비교용 (curriculum/ 로 따로 저장)
TOTAL      = int(sys.argv[sys.argv.index("--steps") + 1]) if "--steps" in sys.argv else 600_000
# 저장 간격을 **평가 간격과 맞춘다** (2026-09-13, 10만 → 2.5만).
#   ProgressLogCallback 이 2.5만마다 평가하는데 저장은 10만마다여서, 평가에서 관측된
#   성능이 파일로 남지 않는 지점이 있었다. 실제로 그 일이 일어났다 — 실행
#   20260913_1444 는 27.5만 평가에서 성공률 100% 였으나 저장 지점이 아니어서
#   그 정책이 남지 않았고, 회수 가능한 최량 체크포인트는 30만의 35% 였다.
#   ⚠ 대가: 실행당 zip 이 5개에서 15개로 늘고(각 159KB), 재평가(record/summarize)가
#     전체 zip 을 20 에피소드씩 돌므로 그만큼 느려진다.
SNAP_FREQ  = 25_000
N_ENVS     = 4          # 병렬 환경: 그래디언트 분산을 줄여 후반 정책 붕괴를 막는다


def evaluate(model, n_episodes=20, seed0=10_000):
    """성공률까지 같이 재는 평가 (평균보상만으로는 '근처 도달'과 구분이 안 된다)."""
    env = FR5ScrewAssemblyEnv()
    rewards, successes, depths, regrips = [], 0, [], []
    for i in range(n_episodes):
        obs, _ = env.reset(seed=seed0 + i)
        total = 0.0
        for _ in range(MAX_STEPS):
            action, _ = model.predict(obs, deterministic=True)
            obs, r, term, trunc, info = env.step(action)
            total += r
            if term or trunc:
                break
        rewards.append(total)
        successes += bool(info["is_success"])
        depths.append(info["depth_mm"])
        regrips.append(info["regrips"])
    return (float(np.mean(rewards)), successes / n_episodes,
            float(np.mean(depths)), float(np.mean(regrips)))


class ProgressLogCallback(BaseCallback):
    """
    구간마다 '성공률 / 체결깊이 / 문지름' 을 재서 로그에 남긴다.

    SB3 기본 로그(ep_rew_mean 등)만으로는 '근처까지 갔는지'와 '실제로 잠갔는지'가
    구분되지 않는다. 이 태스크의 성공은 **어깨 착좌**(나사부 완전 체결)이므로 따로 잰다.
    """

    def __init__(self, every=25_000, n_episodes=10, verbose=0):
        super().__init__(verbose)
        self.every = every
        self.n_episodes = n_episodes
        self.next_at = every

    def _on_step(self):
        if self.num_timesteps < self.next_at:
            return True
        self.next_at += self.every
        env = FR5ScrewAssemblyEnv()
        succ, depths, jams = 0, [], []
        for i in range(self.n_episodes):
            obs, _ = env.reset(seed=9000 + i)
            for _ in range(MAX_STEPS):
                a, _ = self.model.predict(obs, deterministic=True)
                obs, _, te, tr, info = env.step(a)
                if te or tr:
                    break
            succ += bool(info["is_success"])
            depths.append(info["depth_mm"]); jams.append(info["jam_steps"])
        sr = succ / self.n_episodes
        self.logger.record("task/success_rate", sr)
        self.logger.record("task/depth_mm", float(np.mean(depths)))
        self.logger.record("task/jam_steps", float(np.mean(jams)))
        self.logger.dump(self.num_timesteps)
        print(f"   📈 {self.num_timesteps:>7,} 스텝 | 성공률 {sr*100:5.1f}% | "
              f"체결깊이 {np.mean(depths):5.2f}mm | 문지름 {np.mean(jams):5.1f}회", flush=True)
        return True


class SnapshotCallback(BaseCallback):
    """마일스톤 + 주기 스냅샷 저장.

    **이번 실행이 실제로 쓴 파일 경로를 `written` 에 모은다.** 학습이 끝나면 그 목록만
    로그 폴더로 복사한다 — 예전에는 SAVE_DIR 안의 zip 을 전부 복사해서, 이전 실행이
    남긴 스냅샷까지 이번 실행 폴더에 섞여 들어갔다. 환경 치수를 바꾸고 나면 옛 정책과
    새 정책이 한 폴더에 뒤섞여 어느 게 어느 치수로 학습된 건지 알 수 없게 된다.
    """

    def __init__(self, verbose=0):
        super().__init__(verbose)
        # ⚠ **마일스톤과 스냅샷의 기록을 분리한다** (2026-09-13).
        #   하나의 집합을 쓰면 SNAP_FREQ 가 MILESTONES 와 겹치는 순간
        #   (2.5만 간격에서는 25k·100k·250k 가 겹친다) 마일스톤이 먼저 등록돼
        #   **그 지점의 candidate 가 저장되지 않는다.**
        self.saved_ms = set()
        self.saved_snap = set()
        self.written = []          # 이번 실행이 만든 zip 경로만
        os.makedirs(os.path.join(SAVE_DIR, "curriculum"), exist_ok=True)

    def _on_step(self):
        n = self.num_timesteps
        for ms in MILESTONES:
            if ms not in self.saved_ms and n >= ms:
                self.saved_ms.add(ms)
                _p = os.path.join(SAVE_DIR, "curriculum",
                                  f"curriculum_{ms}steps_{STAMP}")
                self.model.save(_p)
                self.written.append(_p + ".zip")
                print(f"   💾 마일스톤 {ms//1000}k 저장", flush=True)
        snap = (n // SNAP_FREQ) * SNAP_FREQ
        if snap >= SNAP_FREQ and snap not in self.saved_snap:
            self.saved_snap.add(snap)
            _p = os.path.join(SAVE_DIR, f"candidate_{snap}steps_{STAMP}")
            self.model.save(_p)
            self.written.append(_p + ".zip")
            print(f"   💾 스냅샷 {snap//1000}k 저장", flush=True)
        return True


if __name__ == "__main__":
    os.makedirs(SAVE_DIR, exist_ok=True)
    snap_cb = SnapshotCallback()
    # 병렬 환경 N_ENVS 개. 롤아웃 크기는 N_ENVS x n_steps 로 정해지므로
    # 단일 환경 2048 과 같게 맞추려면 n_steps 는 512 다.
    train_env = make_vec_env(FR5ScrewAssemblyEnv, n_envs=N_ENVS)
    # ⚠ 학습률은 **상수 3e-4 다.** 감쇠 스케줄을 쓰지 않는다.
    #   2026-09-10 이전에는 아래 출력이 "lr 3e-4 감쇠(하한 20%)" 라고 찍혔는데
    #   코드에 스케줄이 없었다 — 옛 판의 문구가 남은 것이다. 로그만 고쳤고
    #   **하이퍼파라미터는 건드리지 않았다.** 지금 성공률 100% 정책이 이 설정으로
    #   나왔으므로, 여기를 바꾸면 기존 스냅샷과 비교가 성립하지 않는다.
    #   감쇠를 쓰고 싶으면 lr 에 callable 을 넘긴다:
    #     learning_rate=lambda p: 3e-4 * max(0.2, p)   # p: 1.0 -> 0.0
    model = PPO("MlpPolicy", train_env, verbose=0, device="cpu",
                learning_rate=3e-4,
                n_steps=512, batch_size=256,
                gae_lambda=0.95, ent_coef=0.005)

    # 학습 과정을 파일로 남긴다 (stdout + log.txt + progress.csv)
    os.makedirs(LOG_DIR, exist_ok=True)
    model.set_logger(configure(LOG_DIR, ["stdout", "log", "csv"]))

    print(f"🏋️ 실측 기반 나사 체결 정책 학습 시작 (총 {TOTAL:,} 스텝)", flush=True)
    print(f"   알고리즘: PPO (stable-baselines3) / MlpPolicy / device=cpu")
    print(f"   병렬환경 {N_ENVS}개 x n_steps 512 = 롤아웃 {N_ENVS*512} | batch 256 | "
          f"lr 3e-4 고정 | gae_lambda 0.95 | ent_coef 0.005")
    print(f"   로그: {LOG_DIR}log.txt / {LOG_DIR}progress.csv", flush=True)
    print(f"   (실행 시각별 폴더 — 이전 학습 기록은 지우지 않는다)", flush=True)
    _past = sorted(d for d in os.listdir(LOG_ROOT)
                   if os.path.isdir(os.path.join(LOG_ROOT, d)) and d != RUN_STAMP)
    if _past:
        print(f"   이전 학습 {len(_past)}회 보존됨: {', '.join(_past[-5:])}"
              + (" ..." if len(_past) > 5 else ""), flush=True)
    t0 = time.time()
    model.learn(total_timesteps=TOTAL,
                callback=[snap_cb, ProgressLogCallback()])
    _final = os.path.join(SAVE_DIR, f"candidate_{TOTAL}steps_{STAMP}")
    model.save(_final)

    # ⚠ **이번 실행이 만든 것만** 로그 폴더로 복사한다.
    #   예전에는 SAVE_DIR 안의 zip 을 전부 복사해서 이전 실행의 스냅샷까지 섞였다.
    #   치수를 바꾸고 나면 어느 정책이 어느 치수로 학습된 건지 알 수 없게 된다.
    #   SAVE_DIR 쪽 원본은 record/verify 스크립트가 참조하므로 그대로 둔다.
    import shutil
    _snap = os.path.join(LOG_DIR, "models")
    for _src in snap_cb.written + [_final + ".zip"]:
        if not os.path.exists(_src):
            continue
        _dst = os.path.join(_snap, os.path.relpath(_src, SAVE_DIR))
        os.makedirs(os.path.dirname(_dst), exist_ok=True)
        shutil.copy2(_src, _dst)
    print(f"   스냅샷 사본: {_snap} ({len(snap_cb.written)+1}개 — 이번 실행분만)", flush=True)
    print(f"✅ 학습 완료 ({time.time()-t0:.0f}초)", flush=True)

    print("\n📊 [최종 평가] 20 에피소드")
    r, sr, d, rg = evaluate(model)
    print(f"   평균보상 {r:8.1f} | 성공률 {sr*100:5.1f}% | "
          f"평균 체결깊이 {d:5.2f}/{E.SEAT_DEPTH*1000:.2f}mm | 평균 재파지 {rg:.1f}회")
