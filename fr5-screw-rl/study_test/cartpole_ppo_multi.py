"""CartPole PPO — 카트폴 4대를 동시에 학습하고, 한 화면에서 4대가 같이 움직이는 것까지 확인하는 예제."""

import argparse

import gymnasium as gym
import numpy as np
import pygame
from stable_baselines3 import PPO
from stable_baselines3.common.env_util import make_vec_env
from stable_baselines3.common.evaluation import evaluate_policy

MODEL_PATH = "cartpole_ppo_multi"
N_ENVS = 4  # 동시에 굴릴 카트폴 대수


def train(total_timesteps: int) -> PPO:
    """카트폴 4대를 병렬로 굴리면서 PPO 학습."""
    train_env = make_vec_env("CartPole-v1", n_envs=N_ENVS)
    model = PPO("MlpPolicy", train_env, verbose=1, device="cpu")
    model.learn(total_timesteps=total_timesteps)
    model.save(MODEL_PATH)
    print(f"\n모델 저장 완료: {MODEL_PATH}.zip (병렬 환경 {N_ENVS}개 사용)\n")
    train_env.close()
    return model


def evaluate(model: PPO) -> None:
    """렌더링 없이 평균 리워드만 확인 (평가도 4대 병렬로)."""
    eval_env = make_vec_env("CartPole-v1", n_envs=N_ENVS)
    mean_reward, std_reward = evaluate_policy(model, eval_env, n_eval_episodes=20)
    print(f"평가 결과: 평균 리워드 = {mean_reward:.2f} +/- {std_reward:.2f}")
    print("(CartPole-v1 최대 리워드는 에피소드당 500)")
    eval_env.close()


def render(model: PPO, episodes_per_env: int) -> None:
    """카트폴 4대의 화면을 2x2로 붙여서 한 창에 동시에 그린다."""
    envs = [gym.make("CartPole-v1", render_mode="rgb_array") for _ in range(N_ENVS)]
    obs = np.array([env.reset(seed=i)[0] for i, env in enumerate(envs)])

    frame = envs[0].render()
    h, w = frame.shape[:2]
    cols, rows = 2, 2
    pad = 4

    pygame.init()
    screen = pygame.display.set_mode((cols * w + (cols + 1) * pad, rows * h + (rows + 1) * pad))
    pygame.display.set_caption(f"CartPole PPO — {N_ENVS}대 동시 시뮬레이션")
    font = pygame.font.SysFont(None, 24)
    clock = pygame.time.Clock()
    fps = envs[0].metadata.get("render_fps", 50)

    totals = np.zeros(N_ENVS)
    finished = np.zeros(N_ENVS, dtype=int)
    running = True

    while running and finished.min() < episodes_per_env:
        for event in pygame.event.get():
            if event.type == pygame.QUIT or (
                event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE
            ):
                running = False

        # 4대의 관측을 한 번에 배치로 넣어 4개의 행동을 동시에 받는다
        actions, _ = model.predict(obs, deterministic=True)

        for i, env in enumerate(envs):
            step_obs, reward, terminated, truncated, _ = env.step(int(actions[i]))
            totals[i] += reward
            if terminated or truncated:
                finished[i] += 1
                print(f"[카트폴 {i + 1}] 에피소드 {finished[i]}: 리워드 = {totals[i]:.0f}")
                totals[i] = 0.0
                step_obs, _ = env.reset()
            obs[i] = step_obs

        screen.fill((30, 30, 30))
        for i, env in enumerate(envs):
            img = env.render()
            surface = pygame.surfarray.make_surface(img.transpose(1, 0, 2))
            x = pad + (i % cols) * (w + pad)
            y = pad + (i // cols) * (h + pad)
            screen.blit(surface, (x, y))
            label = font.render(
                f"#{i + 1}  reward {totals[i]:.0f}  ep {finished[i]}/{episodes_per_env}",
                True,
                (20, 20, 20),
            )
            screen.blit(label, (x + 8, y + 8))
        pygame.display.flip()
        clock.tick(fps)

    pygame.quit()
    for env in envs:
        env.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timesteps", type=int, default=20000)
    parser.add_argument("--episodes", type=int, default=5, help="렌더링 시 환경당 에피소드 수")
    parser.add_argument("--no-render", action="store_true", help="화면 출력 없이 학습/평가만")
    args = parser.parse_args()

    model = train(args.timesteps)
    evaluate(model)
    if not args.no_render:
        render(model, args.episodes)


if __name__ == "__main__":
    main()
