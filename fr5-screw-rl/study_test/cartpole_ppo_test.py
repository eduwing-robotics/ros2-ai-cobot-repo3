import gymnasium as gym
from stable_baselines3 import PPO
from stable_baselines3.common.evaluation import evaluate_policy

MODEL_PATH = "cartpole_ppo"

# ── 1. 학습 ──────────────────────────────────
train_env = gym.make("CartPole-v1")
model = PPO("MlpPolicy", train_env, verbose=1, device="cpu")
model.learn(total_timesteps=20000)  # CartPole은 이 정도면 충분히 잘 풀림
model.save(MODEL_PATH)
print(f"\n모델 저장 완료: {MODEL_PATH}.zip\n")
train_env.close()

# ── 2. 정량 평가 (렌더링 없이, 평균 리워드 확인) ──
eval_env = gym.make("CartPole-v1")
mean_reward, std_reward = evaluate_policy(model, eval_env, n_eval_episodes=20)
print(f"평가 결과: 평균 리워드 = {mean_reward:.2f} +/- {std_reward:.2f}")
print("(CartPole-v1 최대 리워드는 에피소드당 500)")
eval_env.close()

# ── 3. 화면에 렌더링하며 실제로 움직이는 모습 보기 ──
render_env = gym.make("CartPole-v1", render_mode="human")
obs, info = render_env.reset()

for episode in range(5):
    obs, info = render_env.reset()
    done = False
    total_reward = 0
    while not done:
        action, _ = model.predict(obs, deterministic=True)
        obs, reward, terminated, truncated, info = render_env.step(action)
        total_reward += reward
        done = terminated or truncated
    print(f"에피소드 {episode + 1}: 리워드 = {total_reward}")

render_env.close()