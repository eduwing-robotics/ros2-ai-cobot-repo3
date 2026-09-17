#
# 📋 학습 결과 종합 — 영상에 나온 로봇 5대가 각각 어느 학습 결과인지 대조한다
#
# 왜 필요한가
#   영상만 보면 "가운데 금색이 잘한다" 는 것밖에 안 보인다. 그 금색이
#   몇 스텝짜리 체크포인트이고, 학습 로그의 어느 지점이며, 나머지 4대는
#   무엇을 재현한 것인지 한 화면에서 대조할 수 있어야 실물 이식 판단이 선다.
#
# 사용
#   python3 summarize_run.py                 # 최근 학습 실행
#   python3 summarize_run.py --run 20260901_1638
#   python3 summarize_run.py --list          # 보존된 학습 실행 목록
#
import os
import re
import sys

import numpy as np

RUNS = "./train_runs/"


def list_runs():
    if not os.path.isdir(RUNS):
        return []
    return sorted(d for d in os.listdir(RUNS) if os.path.isdir(os.path.join(RUNS, d)))


def load_progress(run):
    import pandas as pd
    p = os.path.join(RUNS, run, "progress.csv")
    return pd.read_csv(p) if os.path.exists(p) else None


def fmt_hms(sec):
    sec = int(round(sec))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h}시간 {m}분 {s}초" if h else (f"{m}분 {s}초" if m else f"{s}초")


def train_summary(run):
    """그 학습 실행의 소요시간·속도·수렴 지점을 뽑는다."""
    d = load_progress(run)
    if d is None or len(d) == 0:
        return None
    ts   = d["time/total_timesteps"].dropna()
    el   = d["time/time_elapsed"].dropna()
    fps  = d["time/fps"].dropna()
    task = d[d["task/success_rate"].notna()] if "task/success_rate" in d else d.iloc[0:0]

    # 결정론적 평가가 처음 100% 에 닿은 스텝
    first100 = None
    if len(task):
        step_per_eval = ts.iloc[-1] / len(task)
        for i, (_, x) in enumerate(task.iterrows(), 1):
            if x["task/success_rate"] >= 1.0:
                first100 = int(round(step_per_eval * i))
                break
    return dict(
        steps=int(ts.iloc[-1]), elapsed=float(el.iloc[-1]),
        fps_mean=float(fps.mean()), fps_max=float(fps.max()),
        rew_first=float(d["rollout/ep_rew_mean"].dropna().iloc[0]),
        rew_last=float(d["rollout/ep_rew_mean"].dropna().iloc[-1]),
        sr_last=float(d["rollout/success_rate"].dropna().iloc[-1]),
        evals=len(task), first100=first100,
        task=task,
    )



def _blocks(run):
    """log.txt 를 PPO 표 블록 단위로 자르고, 각 블록에 그 시점 스텝을 붙인다.

    task/ 블록에는 total_timesteps 가 없다. 바로 앞 rollout 블록의 스텝을
    이어받게 해야 "그 시점의 지표" 를 제대로 고를 수 있다.
    """
    p = os.path.join(RUNS, run, "log.txt")
    if not os.path.exists(p):
        return []
    raw, cur = [], []
    for line in open(p, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("---"):
            if cur:
                cur.append(line); raw.append(cur); cur = []
            else:
                cur = [line]
        elif cur:
            cur.append(line)

    out, last = [], 0
    for blk in raw:
        st = None
        for ln in blk:
            if "total_timesteps" in ln:
                try:
                    st = int(ln.split("|")[2].strip())
                except (IndexError, ValueError):
                    st = None
                break
        if st is not None:
            last = st
        out.append((last, any("task/" in ln for ln in blk), blk))
    return out


def log_block_at(run, step):
    """total_timesteps 가 step 에 가장 가까운 rollout 블록을 원문 그대로."""
    c = [(abs(st - step), blk) for st, is_task, blk in _blocks(run) if not is_task]
    return min(c)[1] if c else None


def task_block_near(run, step):
    """step 에 가장 가까운 task/ 평가 블록 (성공률·체결깊이·문지름)."""
    c = [(abs(st - step), st, blk) for st, is_task, blk in _blocks(run) if is_task]
    if not c:
        return None
    _, st, blk = min(c)
    return st, blk


def main():
    a = sys.argv
    runs = list_runs()
    if "--list" in a:
        print("보존된 학습 실행")
        for r in runs:
            s = train_summary(r)
            n = len([f for f in os.listdir(os.path.join(RUNS, r, "models"))
                     if f.endswith(".zip")]) if os.path.isdir(os.path.join(RUNS, r, "models")) else 0
            extra = f"{s['steps']:,}스텝 / {fmt_hms(s['elapsed'])}" if s else "로그 없음"
            print(f"   {r}   {extra}   모델 {n}개")
        return
    if not runs:
        raise SystemExit("train_runs/ 에 학습 기록이 없습니다. train_screw_ppo.py 를 먼저 실행하세요.")
    run = a[a.index("--run") + 1] if "--run" in a else runs[-1]
    S = train_summary(run)

    W = 92
    print("═" * W)
    print(f" 학습 결과 종합 — 실행 {run}")
    print("═" * W)

    # ── 1. 이번 학습이 얼마나 걸렸나 ──────────────────────────────────
    if S:
        import train_screw_ppo as T
        print("\n▍1. 학습 소요")
        print("─" * W)
        print(f"   총 스텝            {S['steps']:,} 스텝")
        print(f"   소요 시간          {fmt_hms(S['elapsed'])}   ({S['elapsed']:.0f}초)")
        print(f"   병렬 환경          {T.N_ENVS}개  (환경당 {S['steps']//T.N_ENVS:,} 스텝)")
        print(f"   처리 속도          평균 {S['fps_mean']:,.0f} fps / 최고 {S['fps_max']:,.0f} fps")
        print(f"   1만 스텝당         {S['elapsed']/S['steps']*10000:.2f}초")
        if S["first100"]:
            print(f"   첫 100% 도달       약 {S['first100']:,} 스텝 "
                  f"(≈ {S['elapsed']*S['first100']/S['steps']:.0f}초 지점)")
        print(f"   평균 보상          {S['rew_first']:,.0f}  ->  {S['rew_last']:,.0f}")

    # ── 2. 학습 중 결정론적 평가 추이 ─────────────────────────────────
    if S is not None and len(S["task"]):
        print("\n▍2. 학습 중 평가 추이  (25,000 스텝마다 / 탐색 잡음 없이)")
        print("─" * W)
        # 막대 둘 — 무엇을 그린 것인지 머리글에 박는다.
        #   성공률: 16칸 = 100% (높을수록 좋다)
        #   문지름: 1칸 = 1회  (**낮을수록 좋다** — 결합면을 비비면 나사산·모서리가 상한다.
        #           16칸을 넘으면 `+` 로 접는다. 원값은 왼쪽 숫자 열에 그대로 있다)
        SR_CELLS, JAM_CELLS = 16, 16
        print(f"   {'스텝':>10} {'성공률':>8} {'체결깊이':>10} {'문지름':>8} │ "
              f"{'성공률 (16칸=100%)':<22}│ 문지름 (1칸=1회 · 적을수록 좋다)")
        sp = S["steps"] / len(S["task"])
        for i, (_, x) in enumerate(S["task"].iterrows(), 1):
            sr = x["task/success_rate"]
            jam = float(x["task/jam_steps"])
            sr_bar = "█" * int(round(sr * SR_CELLS))
            n = int(round(jam))
            jam_bar = "▓" * min(n, JAM_CELLS) + ("+" if n > JAM_CELLS else "")
            print(f"   {int(round(sp*i)):10,} {sr*100:7.0f}% {x['task/depth_mm']:9.2f}mm "
                  f"{jam:7.1f} │ {sr_bar:<{SR_CELLS}}       │ {jam_bar}")

    # ── 3. 영상 5대와 학습 결과 대조 ──────────────────────────────────
    print("\n▍3. 영상 5대 ↔ 학습 결과 대조")
    print("─" * W)
    import record_screw_video as R
    roster, center = R.build_roster()

    import fr5_screw_assembly as E
    from stable_baselines3 import PPO

    print(f"\n   {'자리':>4} {'배역':<14} {'모델 파일':<30} {'성공률':>7} {'깊이':>8} {'문지름':>7} {'재파지':>7}")
    print("   " + "─" * (W - 3))
    rows = []
    for i, (label, path, is_best, cls) in enumerate(roster):
        model = PPO.load(path, device="cpu")
        env = cls(env_id=i)
        succ, dep, jam, rg = 0, [], [], []
        N = 10
        for k in range(N):
            obs, _ = env.reset(seed=5000 + k)
            for _ in range(E.MAX_STEPS):
                act, _ = model.predict(obs, deterministic=True)
                obs, _, te, tr, info = env.step(act)
                if te or tr:
                    break
            succ += bool(info["is_success"])
            dep.append(info["depth_mm"]); jam.append(info["jam_steps"]); rg.append(info["regrips"])
        mark = "  "   # 배역 라벨에 이미 ★ 가 들어 있다
        rows.append((i, label, path, succ / N, np.mean(dep), np.mean(jam), np.mean(rg), is_best))
        print(f"   {i+1:>3}번{mark}{label:<14} {os.path.basename(path):<30} "
              f"{succ/N*100:6.0f}% {np.mean(dep):7.2f}mm {np.mean(jam):6.1f} {np.mean(rg):6.1f}회")

    # ── 4. 실물로 나가는 것 ───────────────────────────────────────────
    b = [r for r in rows if r[7]][0]
    print("\n▍4. 실물 FR5 로 나가는 정책")
    print("─" * W)
    print(f"   영상 자리          {b[0]+1}번 (정중앙 / 금색)")
    print(f"   모델 파일          {b[2]}")
    # ⚠ 파일명의 **숫자를 전부 이어붙이면 안 된다.** 2026-09-08 부터 파일명 끝에 실행
    #   시각이 붙는다(candidate_250000steps_20260908-1221.zip). 이어붙이면
    #   250000 + 20260908 + 1221 이 합쳐져 "250,000,202,609,081,221 스텝" 이 찍혔다.
    #   `<N>steps` 만 읽는다 — fr5_multi_fleet_control.step_of() 와 같은 규칙.
    m = re.search(r"(\d+)steps", os.path.basename(b[2]))
    step = m.group(1) if m else ""
    if step and S:
        frac = int(step) / S["steps"]
        print(f"   학습 지점          {int(step):,} 스텝 "
              f"(전체 {S['steps']:,} 중 {frac*100:.0f}%, "
              f"≈ {S['elapsed']*frac:.0f}초 지점)")
    print(f"   성공률             {b[3]*100:.0f}%")
    print(f"   평균 체결깊이       {b[4]:.2f} / {E.SEAT_DEPTH*1000:.2f} mm")
    print(f"   결합면 문지름       {b[5]:.1f} 스텝")
    print(f"   재파지             {b[6]:.1f}회  (한 스트로크 350° 제약)")

    # ── 이 체크포인트가 학습될 때 실제로 찍힌 로그를 그대로 보여준다 ──────
    if step:
        blk = log_block_at(run, int(step))
        if blk:
            print(f"\n   학습 로그 — {int(step):,} 스텝 시점 (log.txt 원문)")
            for ln in blk:
                print("     " + ln)
        tb = task_block_near(run, int(step))
        if tb:
            tstep, tblk = tb
            print(f"\n   같은 시점 과제 지표 — {tstep:,} 스텝 (탐색 잡음 없이 평가)")
            for ln in tblk:
                print("     " + ln)

    print(f"\n   실행:  python3 fr5_execute_policy.py     (기본 dry-run)")

    # ── 5. 나머지 4대가 무엇인지 ──────────────────────────────────────
    print("\n▍5. 나머지 4대 — 서로 다른 실패 양상")
    print("─" * W)
    why = {
        "① 접근 실패": "탄피 입구를 못 찾고 헤맨다. 학습 초반(25k) 상태를 재현.",
        "② 문지름":   "입구에 닿은 채 계속 비빈다. 결합면이 상하는 양상.",
        "③ 입구위 호버링": "입구 위에서 멈춘다. 하강 보상만 먹는 국소최적.",
        "④ 회전 부족": "물리기는 하는데 회전이 모자라 끝까지 못 들어간다.",
    }
    for i, label, path, sr, dp, jm, rgp, is_best in rows:
        if is_best:
            continue
        print(f"   {i+1}번  {label:<14} {why.get(label,''):<44} 최대깊이 {dp:.2f}mm")

    print("\n" + "═" * W)
    print(f" 영상: screw_wide.mp4 / screw_closeup.mp4 / screw_macro.mp4")
    print(f" 로그: {RUNS}{run}/log.txt · progress.csv · models/")
    print("═" * W)


if __name__ == "__main__":
    main()
