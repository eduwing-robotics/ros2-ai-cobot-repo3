# FR5 나사 체결 강화학습

FAIRINO FR5 협동로봇이 탄두를 탄피에 나사 결합하는 작업을 PPO 로 학습한다.

## 이 작업의 제약

착좌까지 **6.25 바퀴**가 필요한데(전진 5.00mm ÷ 피치 0.8mm), j6 가동범위가 ±175° 라
한 스트로크가 **344° = 0.956 바퀴**뿐이다. 따라서 6.54 스트로크가 필요하고,
스트로크 사이마다 `그리퍼 열기 → 손목 되감기 → 다시 잡기` 가 들어간다.

## 학습 환경

`fr5_screw_assembly.py` 는 **MuJoCo 물리를 사용하지 않는다.** 나사 결합의 지배 관계
`전진 = 회전 × 피치 ÷ 2π` 를 해석식으로 모델링했다. MuJoCo 는 역기구학 · 자기충돌
검사 · 렌더링에만 쓴다. 그 덕에 30만 스텝 학습 1회가 1분에 끝나 반복 검증이 가능하다.

| | |
|---|---|
| 상태 | 15차원 — 위치·기울기·편심·깊이·물림여부·접촉플래그·측력·회전각·누적문지름 |
| 행동 | 6차원 — 위치 증분 3 · 기울기 증분 2 · 툴축 회전 증분 1 |
| 제어 주기 | 1.5초 (실기 운용 속도에서 역산) |
| 성공 기준 | 어깨 착좌 = 체결 깊이 6.00mm |

## 구성

```
src/                        학습 · 실기 스크립트
  fr5_screw_assembly.py       학습 환경 (Gymnasium)
  train_screw_ppo.py          PPO 학습
  verify_screw_policy.py      학습 결과를 MuJoCo 창에서 확인
  record_screw_video.py       영상 녹화 (3앵글)
  fr5_execute_policy.py       실기 실행 (기본 dry-run)
  fr5_site.py                 현장 실측값 SSOT
  selfcheck.py                자기충돌 · 책상 이격 검사
  measure_min_step.py         컨트롤러 최소 실행 이동량 측정
  fairino5_v6_mjmodel.xml     MuJoCo 씬
  task_origin.json            작업 원점 [실측 2026-09-07]
meshes/                     로봇 · 그리퍼 · 탄두 · 탄피 · 고정대 STL
models/                     선정 정책 1개
study_test/                 초기 연습 코드 (CartPole) — 본 작업과 무관
```

환경(온·습도) 제어 시스템은 이 프로젝트와 독립이라 저장소 최상위의
[`fr5-safety_system/`](../fr5-safety_system/) 에 따로 둔다.

## 실행

```bash
pip install -r requirements.txt
cd src

python3 train_screw_ppo.py --steps 300000     # 학습 (약 1분)
python3 verify_screw_policy.py                # MuJoCo 창에서 확인
python3 record_screw_video.py --steps 340     # 영상 3편
python3 fr5_execute_policy.py                 # 실기 dry-run
```

## 포함된 정책

`models/candidate_225000steps_20260913-1535.zip`
20 에피소드 재평가 기준 **성공률 100%, 문지름 0.0 스텝**.
동일 조건 15회 학습 중 최량이다.

## 실기 실행 전 확인

`fr5_execute_policy.py` 는 기본이 dry-run 이며, 실물 실행에는 선행 조건 3개가 필요하다.

| 게이트 | 상태 |
|---|---|
| 작업 원점 실측 | 닫힘 (2026-09-07) |
| 툴축 부호 `ZSIGN_VERIFIED` | **열림** — 부호는 확인됐으나 플래그는 False |
| 충돌 감지 정지 `COLLISION_STOP_VERIFIED` | **열림** |

조립은 조이는 방향이라 실패가 과조임이고 되돌릴 수 없다. 게이트가 닫히기 전에는
실물 실행이 거부된다.

## 알려진 한계

- 스트로크당 실제 전진량 `0.764mm` 는 **계산값**이다. 실측하지 않았다.
- 재파지 소요 시간을 시뮬은 1.5초로 친다. 실측하지 않았다.
- 컨트롤러가 지령대로 실행하는 **최소 이동량은 0.8mm** 로 측정됐다(2026-09-13).
  스트로크당 전진량이 그 아래라, 실기에서 지령대로 전진하지 않을 수 있다.
- 동일 조건 15회 학습에서 최종 성공률 표준편차가 **30.7%p** 였다. 단일 실행 결과로
  성능을 판단하지 말고, 체크포인트를 재평가해 고를 것.
