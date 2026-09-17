#
# 🎭 발표용 '실패 양상' 정책 세트 생성
#
# 재생 화면에서 로봇 4대가 똑같이 움직이면 비교 검증의 의미가 없다.
# 정중앙(금색)은 정상 체결 정책을 두고, 나머지 4대는 학습 과정에서 실제로
# 나타났던 서로 다른 실패 모드를 하나씩 보여주도록 정책을 만들어 둔다.
#
# 네 가지 모두 '보상 설계를 한 군데씩 망가뜨리면 어떤 실패가 나오는지'를
# 재현한 것이라, 발표에서 보상 설계의 근거를 그대로 설명할 수 있다.
#
#   ① 접근 실패   : 하강 셰이핑 제거    -> 내려갈 이유가 없어 위에서 배회
#   ② 문지름     : 문지름 페널티 제거   -> 정렬 전에 내려가 결합면을 계속 비빔
#   ③ 호버링     : 문지름 페널티 과다   -> 결합면 접근 자체를 회피
#   ④ 회전 부족   : 재파지 비용 과다    -> 한 스트로크만 돌리고 멈춤
#
# 초기 체크포인트를 쓰지 않고 학습 조건으로 만드는 이유는 재현성 때문이다.
# (2천 스텝 초기 정책은 무작위 초기화 탓에 실행마다 양상이 달라진다)
#
# 만든 뒤에는 classify_failures.py 로 라벨을 검증한다.
#
import os

from stable_baselines3 import PPO
from stable_baselines3.common.env_util import make_vec_env

from fr5_screw_assembly import FR5ScrewAssemblyEnv

OUT_DIR = "./models_failures/"


class NoDescentEnv(FR5ScrewAssemblyEnv):
    """하강 셰이핑 제거. 편심·기울기만 보상하므로 내려갈 이유가 없어 배회만 한다."""
    DESCENT_WEIGHT = 0.0


class RubFreeEnv(FR5ScrewAssemblyEnv):
    """
    문지름 페널티 제거. 결합면에 대고 비비며 축을 맞추는 것이 공짜가 되어,
    정렬 전에 일단 내려가 계속 비비는 정책이 학습된다.
    -> 이 페널티가 왜 필요한지를 그대로 보여주는 대조군.
    """
    JAM_PENALTY_BASE = 0.0
    JAM_ESCALATION_RATE = 0.0


class RubAverseEnv(FR5ScrewAssemblyEnv):
    """
    문지름 페널티 과다. 접촉이 너무 비싸져 결합면 바로 위까지는 가지만
    내려가 닿는 것을 회피하고, 입구 위에서 정렬만 한 채 대기한다.
    -> 페널티를 키우면 해결될 것 같지만 실제로는 학습이 죽는다는 반례.
       (30 까지 올리면 아예 멀리서 배회해 ① 과 구분이 안 되므로 10 을 쓴다)
    """
    JAM_PENALTY_BASE = 10.0


class SlowSpinEnv(FR5ScrewAssemblyEnv):
    """
    회전 속도를 1/8 로 제한한 환경(손목이 느리게 도는 경우를 가정).
    정렬·물림까지는 정상적으로 하지만 제한 시간 안에 착좌 깊이(SEAT_DEPTH)를 다 잠그지 못한다.
    -> "물리긴 했는데 끝까지 잠그지 못하고 서 있는" 실패 양상.

    보상만 낮추는 방식(FASTEN_WEIGHT=100)도 시도했으나 아예 물리지도 않아
    ③ 호버링과 구분이 안 됐다. 회전 능력 자체를 제한하는 편이 확실하다.
    """
    SPIN_SCALE_FACTOR = 0.125


EXHIBITS = [
    ("① 접근 실패", NoDescentEnv,    120_000, "01_wander"),
    # 20만 스텝까지 두면 문지르면서도 결국 체결에 성공해 실패 양상이 안 보인다.
    ("② 문지름",    RubFreeEnv,       60_000, "02_jam"),
    ("③ 호버링",    RubAverseEnv,    200_000, "03_hover"),
    ("④ 회전 부족", SlowSpinEnv,     200_000, "04_stall"),
]


def train(env_cls, steps, out_name, n_envs=4):
    env = make_vec_env(env_cls, n_envs=n_envs)
    model = PPO("MlpPolicy", env, verbose=0, device="cpu",
                learning_rate=3e-4, n_steps=512, batch_size=256,
                gae_lambda=0.95, ent_coef=0.005)
    model.learn(total_timesteps=steps)
    model.save(os.path.join(OUT_DIR, out_name))
    print(f"   💾 {out_name}.zip 저장 ({steps:,} 스텝)")


if __name__ == "__main__":
    import sys
    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
    os.makedirs(OUT_DIR, exist_ok=True)
    print("🎭 실패 양상 정책 생성")
    for label, env_cls, steps, name in EXHIBITS:
        if only and name not in only:
            continue
        print(f"{label} — {env_cls.__name__}")
        train(env_cls, steps, name)
    print("\n검증:  python3 classify_failures.py ./models_failures/")
