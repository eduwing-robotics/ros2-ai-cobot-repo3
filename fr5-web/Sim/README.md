# Sim — 승인된 것을 여러 조건에서 **재는** 곳 (판정 · 장면 · 배치 · 화면은 미착수)

계약 `docs/ref/contract/SIM-CONTRACT.md`. 골 `docs/goals/GOAL-sim-batch.md`.

**시뮬은 실기에 무엇을 넣지 않는다. 실기가 이미 정한 것을 읽어 갈 뿐이다** (D96).
그래서 이 폴더는 `FR5/bridge` 를 **import 하지 않는다** — 게이트가 `grep` 으로 잰다.

## 폴더

| 경로 | 무엇 |
|---|---|
| `runner/judge.mjs` | 위반 판정. **`safety.check_workspace` 의 규칙을 옮긴 것**이지 새 정의가 아니다 |
| `runner/clearance.mjs` | 여유(mm) 계측. **판정이 아니다** — 「위반 0」과 「여유 1mm」를 가른다 |
| `runner/grasp.mjs` | 파지 기하 계측. **판정이 아니다** — 물림·편심을 숫자로 내고 **문턱은 안 정한다** (합격선은 칸 4 의 채점 스펙이 값으로 든다) |
| `scene/build-scene.mjs` | `config.yaml`·URDF·`props.js` → MJCF. **생성물이다** — 좌표를 손으로 옮겨 적지 않는다. 받침·작업물은 **충돌체**로 서지 구역이 아니다 |
| `runner/batch.mjs` | N벌 증식·실행·이벤트 수집. 세 파일을 낸다 |
| `fixtures/` | 실기에서 구운 입력(슬롯·좌표계·손끝 표본). **커밋한다** — 게이트가 로봇 없이 돌아야 하니까 |
| `out/` | 산출물. **커밋하지 않는다** (D14 · `.gitignore`). 다시 구우면 그대로 나온다 |

**화면은 `Sim/` 밖에 있다** — `Dashboard/src/features/sim/`(`SimTab`·`ReplayView`·`SweepCloud`).
관제화면 탭 하나라 여기 두지 않았다. `Sim/` 은 굽는 쪽, Dashboard 는 읽는 쪽이고 사이는 `out/` 의 파일이다.

```bash
node Sim/scene/build-scene.mjs        # Sim/out/scene/fr5-lab-a.xml
node Sim/runner/batch.mjs --n 96      # 6초 · Sim/out/<batchId>/ 세 파일
bash scripts/check/sim-scene.sh       # 장면이 정말 생성물인가 (입력을 흔들면 따라오나)
bash scripts/check/sim-batch.sh       # 완주·재현성, 그리고 주입하면 잡나
node scripts/dev/sim-fixture.mjs      # 픽스처 다시 굽기 — **로봇이 붙어 있어야 한다**
```

## 이 폴더의 유일한 위험 — **판정이 갈리는 것**

시뮬이 관대하면 화면이 초록인 프로그램을 실기가 거부하고, 엄격하면 멀쩡한 프로그램을
위험하다고 말한다. 둘 다 화면을 근거가 아니라 그림으로 만든다 (불변식 4).

```bash
node scripts/check/sim-parity.mjs      # 자세 200개 · 실기 게이트와 대조 · 불일치 0 이어야 통과
bash scripts/check/sim-grasp.sh        # 파지 기하가 네 자세를 가르나 (맞음·높음·낮음·빗나감)
```

⛔ **`judge.mjs` 를 고치면 반드시 이 게이트를 다시 돌린다.** 여기서만 고치고 지나가면
그날부터 두 정의가 조용히 갈라지고, 그 사실은 96벌을 다 돌린 뒤에도 안 보인다.

⛔ **상한을 여기서 만들지 않는다** (`SAFETY-RULES.md` §상한). 시뮬용 상한이 곧 게이트 우회로다.

## 아직 없는 것

**배치 실행 · 이벤트 수집 · 화면.** 순서와 각 칸의 천장은 계약 §단계, 화면 규약은 계약 §화면.

⚠ **Embind 핸들은 GC 되지 않는다** — `MjModel`·`MjData`·버퍼는 `.delete()` 를 손으로 부른다
(`node_modules/@mujoco/mujoco/README.md` §Memory Management). 하드 상한이 fps 가 아니라
**메모리**(`MjData` 148개)라, 안 지우면 N 을 못 올린다. `data.contact` 는 **스텝마다 새 사본**이고
`data.qpos` 는 반대로 살아있는 뷰다.
