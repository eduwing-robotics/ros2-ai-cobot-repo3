#
# 🔎 나사 체결 PPO 하이퍼파라미터 탐색 (Optuna)
#
# **왜 만드나** — `train_screw_ppo.py` 의 `lr 3e-4 · n_steps 512 · batch 256 ·
# gae_lambda 0.95 · ent_coef 0.005` 는 전부 **관례값**이고 근거가 코드에 없다.
# 이 스크립트는 그 값에 근거를 붙인다: "3e-4 를 썼다" 가 아니라 "N회 시행에서 이게 최고였다".
#
# **첫 시행은 항상 관례값이다** (`enqueue_trial`). 그래야 결과가 "탐색이 이겼나 졌나" 로
# 읽힌다 — 이기지 못하면 그것도 결론이다(관례값이 이미 좋다).
#
# ⚠ **`models_screw/` 에 아무것도 안 쓴다.** `record_screw_video.py` 가 그 폴더를
#   재귀 검색해 후보를 고르기 때문에, 탐색 중 모델이 섞이면 녹화 후보가 오염된다
#   (`train_screw_ppo.py` 머리주석과 같은 이유). 산출물은 전부 `tune_runs/<시각>/` 안이다.
# ⚠ **이전 탐색을 지우지 않는다** — 학습 로그 규약과 같다("이전꺼 지우지 말고", 2026-09-01).
#   SQLite 에 쌓이므로 중단해도 이어서 돌릴 수 있다 (`--study` 로 같은 이름을 주면 재개).
#
# 쓰기
#   python src/tune_screw_ppo.py                          # 20 trial x 60k 스텝
#   python src/tune_screw_ppo.py --trials 40 --trial-steps 100000
#   python src/tune_screw_ppo.py --study screw_v2 --resume # 같은 study 이어서
#
import argparse
import json
import os
import time

import optuna
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.env_util import make_vec_env

from fr5_screw_assembly import FR5ScrewAssemblyEnv
import fr5_screw_assembly as E   # 성공 기준 깊이(SEAT_DEPTH)를 출력에 쓴다
# 평가 함수는 **학습 스크립트에서 그대로 가져온다.** 여기서 다시 구현하면 지표가 갈라지고,
# 갈라지면 탐색이 고른 값이 학습 쪽 성적과 다른 것을 재게 된다.
# (`--steps` 가 아니라 `--trial-steps` 를 쓰는 이유 — 그쪽 모듈이 임포트 시점에
#  `sys.argv` 에서 `--steps` 를 읽는다. 이름이 겹치면 서로의 인자를 주워 간다.)
from train_screw_ppo import evaluate

TUNE_ROOT = "./tune_runs/"
N_ENVS = 4                      # 학습 쪽과 같게 둔다 — 롤아웃 크기 계산의 전제다

# 관례값 — `train_screw_ppo.py` 가 지금 쓰는 값 그대로. **첫 trial 이 이것이다.**
BASELINE = {
    "learning_rate": 3e-4, "n_steps": 512, "batch_size": 256,
    "gae_lambda": 0.95, "ent_coef": 0.005,
    "clip_range": 0.2, "n_epochs": 10, "gamma": 0.99,
}


def _new_run_dir():
    """탐색마다 새 폴더. 기존 폴더는 절대 건드리지 않는다 (학습 로그 규약과 같다)."""
    os.makedirs(TUNE_ROOT, exist_ok=True)
    base = time.strftime("%Y%m%d_%H%M")
    stamp, n = base, 2
    while os.path.exists(os.path.join(TUNE_ROOT, stamp)):
        stamp, n = f"{base}_{n}", n + 1
    return stamp


def _divisors_upto(rollout, cands=(64, 128, 256, 512, 1024)):
    """`batch_size` 는 롤아웃(N_ENVS x n_steps)을 나눠떨어져야 한다.

    안 나눠떨어지면 SB3 가 **경고만 하고 마지막 미니배치를 잘라** 조용히 다른 학습이 된다.
    탐색이 그런 조합을 고르면 원인 모를 성적 차이가 생기므로 후보에서 아예 뺀다.
    """
    return [b for b in cands if b <= rollout and rollout % b == 0]


class PruneCallback(BaseCallback):
    """중간 성공률을 Optuna 에 보고해 **가망 없는 trial 을 일찍 끊는다.**

    보상이 아니라 **성공률**을 본다 — 학습 스크립트가 적어 둔 그대로,
    평균보상만으로는 「근처 도달」과 「실제로 잠갔다」가 구분되지 않는다.
    """

    def __init__(self, trial, every, n_eval):
        super().__init__()
        self.trial, self.every, self.n_eval = trial, every, n_eval
        self.step_mark = 0

    def _on_step(self):
        if self.num_timesteps - self.step_mark < self.every:
            return True
        self.step_mark = self.num_timesteps
        _, sr, depth, _ = evaluate(self.model, n_episodes=self.n_eval)
        # 최종 목적값과 **같은 식**으로 본다 — 다르면 가지치기가 다른 것을 재게 된다
        self.trial.report(sr + 0.01 * (depth / (E.SEAT_DEPTH * 1000)), self.num_timesteps)
        if self.trial.should_prune():
            raise optuna.TrialPruned()
        return True


def make_objective(args, run_dir):
    def objective(trial):
        n_steps = trial.suggest_categorical("n_steps", [256, 512, 1024])
        rollout = N_ENVS * n_steps
        batch_size = trial.suggest_categorical("batch_size", _divisors_upto(rollout))
        params = dict(
            learning_rate=trial.suggest_float("learning_rate", 1e-5, 1e-3, log=True),
            n_steps=n_steps, batch_size=batch_size,
            gae_lambda=trial.suggest_float("gae_lambda", 0.90, 0.99),
            ent_coef=trial.suggest_float("ent_coef", 1e-4, 5e-2, log=True),
            clip_range=trial.suggest_float("clip_range", 0.1, 0.3),
            n_epochs=trial.suggest_int("n_epochs", 5, 20),
            gamma=trial.suggest_float("gamma", 0.97, 0.999),
        )
        env = make_vec_env(FR5ScrewAssemblyEnv, n_envs=N_ENVS, seed=args.seed)
        model = PPO("MlpPolicy", env, verbose=0, device="cpu", seed=args.seed, **params)
        try:
            model.learn(total_timesteps=args.trial_steps,
                        callback=PruneCallback(trial, args.eval_every, args.eval_episodes))
        finally:
            env.close()
        rew, sr, depth, regrips = evaluate(model, n_episodes=args.final_episodes)
        # ── 목적값 = 성공률 + **체결 깊이 미세 보정** ──────────────────────
        # 성공률만 쓰면 계단형이다. 20 에피소드면 해상도가 5%p 이고, **아무도 성공
        # 못 하는 구간에서는 모든 trial 이 0.0 으로 같다** — TPE 가 구별할 신호가 없어
        # 랜덤 탐색이 되고, MedianPruner 도 값이 같아 아무것도 못 끊는다.
        # 깊이는 연속값이라 "얼마나 돌려 넣었나" 로 trial 을 가른다.
        # **가중치 0.01 < 성공 1건의 값 0.05** 이므로 진짜 성공 차이를 절대 못 뒤집는다.
        # ⚠ 물림조차 못 하면 깊이도 0 이라 이 보정도 안 먹는다 — 그때는 평균보상을
        #   3순위로 넣어야 한다. 첫 실행 결과를 보고 정한다.
        # ⚠ 분모는 **성공 기준 깊이**다. 7.0(나사부 길이) 로 두면 목적값이 실제보다
        #   작게 나와 시행 간 비교가 어긋난다.
        score = sr + 0.01 * (depth / (E.SEAT_DEPTH * 1000))
        trial.set_user_attr("success_rate", sr)
        trial.set_user_attr("mean_reward", rew)
        trial.set_user_attr("mean_depth_mm", depth)
        trial.set_user_attr("mean_regrips", regrips)
        # **가장 좋은 trial 의 모델만** 남긴다 (`models_screw/` 가 아니라 여기).
        # `best_value` 는 **앞선 완료 trial** 들의 최고다 — 지금 trial 은 아직 기록 전이라
        # 첫 trial 에서는 없다(ValueError). 그래서 없으면 무조건 저장한다.
        try:
            prev_best = trial.study.best_value
        except ValueError:
            prev_best = -1.0
        if sr >= prev_best:
            model.save(os.path.join(run_dir, "best_model"))
        print(f"   trial {trial.number:3d} | 점수 {score:6.4f} | 성공률 {sr*100:5.1f}% | "
              f"보상 {rew:8.1f} | 깊이 {depth:4.2f}/{E.SEAT_DEPTH*1000:.2f}mm | 재파지 {regrips:.1f}",
              flush=True)
        return score
    return objective


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--trials", type=int, default=20)
    # 기본 예산 — 본학습이 600k 이고 마일스톤이 25k/100k/250k 다. 60k 에서는 성공이
    # 아예 안 나올 수 있어(빗물림 도입 후 더 그렇다) 150k 로 잡는다.
    p.add_argument("--trial-steps", type=int, default=150_000, help="trial 하나당 학습 스텝")
    p.add_argument("--eval-every", type=int, default=30_000, help="중간 평가(가지치기) 간격")
    p.add_argument("--eval-episodes", type=int, default=10, help="중간 평가 에피소드")
    p.add_argument("--final-episodes", type=int, default=20, help="trial 최종 평가 에피소드")
    p.add_argument("--study", default="screw_ppo")
    p.add_argument("--resume", action="store_true", help="같은 study 를 이어서 돌린다")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    run_dir = os.path.join(TUNE_ROOT, _new_run_dir())
    os.makedirs(run_dir, exist_ok=True)
    # SQLite 는 `tune_runs/` 루트에 둔다 — 실행마다 새로 만들면 이어 돌릴 수가 없다
    storage = "sqlite:///" + os.path.abspath(os.path.join(TUNE_ROOT, "studies.db"))

    study = optuna.create_study(
        study_name=args.study, storage=storage, direction="maximize",
        load_if_exists=args.resume,
        sampler=optuna.samplers.TPESampler(seed=args.seed),
        pruner=optuna.pruners.MedianPruner(n_startup_trials=5, n_warmup_steps=1),
    )
    # **관례값을 첫 trial 로 넣는다** — 새 study 일 때만. 이어 돌릴 때 또 넣으면 중복이다
    if not study.trials:
        study.enqueue_trial(BASELINE)

    print(f"🔎 나사 체결 PPO 하이퍼파라미터 탐색", flush=True)
    print(f"   trial {args.trials}개 x {args.trial_steps:,} 스텝 | 목적값 = 성공률")
    print(f"   첫 trial = 관례값 (lr 3e-4 · n_steps 512 · batch 256 · λ 0.95 · ent 0.005)")
    print(f"   기록: {run_dir}/ · study '{args.study}' → {storage}")
    print(f"   ⚠ models_screw/ 에는 아무것도 안 쓴다 (녹화 후보 오염 방지)", flush=True)

    t0 = time.time()
    study.optimize(make_objective(args, run_dir), n_trials=args.trials)

    best, base = study.best_trial, study.trials[0]
    print(f"\n✅ 탐색 완료 ({time.time()-t0:.0f}초 · 완료 {len([t for t in study.trials if t.value is not None])}"
          f" / 가지치기 {len([t for t in study.trials if t.state.name == 'PRUNED'])})")
    print(f"\n📊 관례값(trial 0) 점수 {(base.value or 0):6.4f} "
          f"(성공률 {base.user_attrs.get('success_rate', 0)*100:.1f}%)")
    print(f"   최고 (trial {best.number}) 점수 {best.value:6.4f} "
          f"(성공률 {best.user_attrs.get('success_rate', 0)*100:.1f}%)"
          f"  → {'관례값보다 +' if best.value > (base.value or 0) else '관례값 대비 '}"
          f"{(best.value - (base.value or 0))*100:.1f}%p")
    if best.number == 0:
        print("   ⚠ **관례값이 이겼다.** 탐색이 못 이겼다는 것도 결론이다 — 그대로 둔다.")
    print("\n   최고 파라미터:")
    for k, v in best.params.items():
        mark = "" if k not in BASELINE else ("  (관례값 " + str(BASELINE[k]) + ")")
        print(f"     {k:16s} {v}{mark}")

    out = {"study": args.study, "trial_steps": args.trial_steps,
           "objective": f"success_rate + 0.01 * (depth_mm / {E.SEAT_DEPTH*1000:.2f})",
           "baseline": BASELINE, "baseline_score": base.value,
           "baseline_attrs": base.user_attrs,
           "best_trial": best.number, "best_score": best.value,
           "best_params": best.params, "best_user_attrs": best.user_attrs}
    with open(os.path.join(run_dir, "result.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\n   결과: {run_dir}/result.json")
    print(f"   ⚠ 이 값을 train_screw_ppo.py 에 박기 전에 **전체 스텝으로 한 번 재현**하라 —"
          f" {args.trial_steps:,} 스텝에서 좋은 것이 600k 에서도 좋다는 보장은 없다.", flush=True)


if __name__ == "__main__":
    main()
