# study_test

초기 학습 단계에서 만든 연습 코드다. 나사 체결 프로젝트와 직접 관계는 없고,
PPO 와 Stable-Baselines3 사용법을 익히려고 CartPole 로 시험한 것이다.

| 파일 | 내용 |
|---|---|
| `cartpole_ppo_multi.py` | CartPole 4대를 동시에 학습하고 한 화면에서 같이 움직이는 것을 확인 |
| `cartpole_ppo_test.py` | 저장된 CartPole 정책을 불러와 평가 |

`cartpole_ppo_multi.py` 의 **여러 대를 한 화면에서 동시에 재생하는 방식**은
이후 `fr5_multi_fleet_control.py` 의 5대 동시 관찰로 이어졌다.
