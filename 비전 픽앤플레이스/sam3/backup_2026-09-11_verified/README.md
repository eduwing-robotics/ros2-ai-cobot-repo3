# FR5 비주얼 서보잉 픽앤플레이스 — 검증된 백업 (2026-09-11 17:33)

## 되돌리기

```bash
cp -p /home/kimsunil/SAM3/backup_2026-09-11_verified/{sam3_pick_ros2.py,*.json} \
      "/home/kimsunil/SAM3/VISIONSCRIPTS/"
```

## 이 판의 핵심 수정 — `settle()`

`move_rel` / `move_abs` 가 **거리만 보고 도달을 판정**했다. `tol` 안에 들어오는
순간 통과시켜, 감속 구간에서 아직 1.8mm 남았는데 그리퍼를 닫았다.
꽂힌 탄두는 리브 위로 물릴 구간이 2~3mm 뿐이라 이것만으로 3회 연속 빈손(`done=1`)이었다.

`settle()` 은 **허용치 안 + 3회 연속 0.05mm 미만 이동(실제 정지)** 을 모두 본다.

```
                        고치기 전            고친 후
하강 목표차   (-0.65, +1.54, +1.73) mm   (-0.01, -0.04, +0.04) mm
들어올리기         +98.21 mm                 +99.94 mm
놓기 목표차        +2.99 mm                  +0.06 mm
그리퍼 17         done=1 (빈손)            done=2 (물림)
```

탄피는 잡을 높이 여유가 커서 같은 버그를 안고도 5회 완주했다 —
**한 종류가 되는 것은 판정 로직의 검증이 아니다.**

## 파일

| 파일 | 내용 |
|---|---|
| `sam3_pick_ros2.py` | 본체 1330줄. `settle()` + `KIND_CFG` + 깊이 검출 |
| `grip_offset.json` | 탄피 파지 보정값 + 조정 이력 |
| `tandu_align_ref.json` | 탄두 보정값을 측정한 정렬 기준 자세 |
| `aligned_poses.json` | 정렬 완료 기록 누적 |
| `home_pose.json` | 시작 위치 (참고용. 코드는 `HOME_JOINTS` 상수를 씀) |
| `home.py` | 홈으로 이동 (JNTPoint + MoveJ, offset 0 복귀 포함) |
| `jog.py` | 상대 이동 `jog.py dx dy dz [속도]` |
| `goto.py` | 절대 이동 `goto.py x y z [rx ry rz] [--speed=N]` |
| `grip.py` | 그리퍼만 `grip.py <위치>` (35 개방 / 25 파지 / 탄두 17) |
| `grab.py` | 프레임 1장 캡처 |
| `depth_profile.py` | 깊이 분위수·히스토그램·임계별 덩어리 (로봇 안 움직임) |
| `dp_points.py` | 지정 픽셀들의 깊이 실측 (트레이 리브 vs 물체 비교용) |
| `dp_mask.py` | 트레이 유효깊이 마스크·히트맵 저장 |
| `watch_detect.py` | 검출 실시간 감시 |
| `why.py` / `prompts.py` / `eval_prompts.py` | 마스크 덤프 · 프롬프트 점수 측정 |
| `yolo_*.py` | 학습 모델 전이 시도 (실패. 문서 참고) |
| `md2txt.py` | LEADME 문서 .md → .txt 변환 (`md2txt.py <파일.md>`) |
| `run_09-11_settle-fix_first.log` | 수정 후 첫 완주 (탄두, `done=2`) |
| `run_09-11_settle-fix_success.log` | 수정 후 2회차 완주 (탄두, `done=2`) |
| `run_log_2026-09-11_tandu_align_ok.txt` | 탄두 정렬 성공 (파지 실패 판) |
| `run_log_2026-09-11_verified.txt` | 탄피 전 구간 완주 |
| `비주얼서보잉-실기검증.{md,txt}` | 검증 문서 988줄 / 927줄 |

## 검증된 실행

```bash
cd "/home/kimsunil/SAM3/VISIONSCRIPTS"
# 탄피
~/sam3_env/bin/python -u sam3_pick_ros2.py --descend --display --sign "+,-" \
    --threshold 0.15 --min-len-mm 0 --exclude "430,0,640,480"

# 탄두 (격자에 꽂힌 물체). 3회 연속 완주
~/sam3_env/bin/python -u sam3_pick_ros2.py --descend --display \
    --detector sam3 --threshold 0.03 --min-len-mm 0 \
    --sign "+,-" --exclude "430,0,640,480"

# ⚠️ --detector both --require-both 는 쓰지 마라 — 검출 0개가 된다.
#    깊이 검출이 트레이 전체를 한 덩어리(9408px)로 만들어 max-area 에 탈락한다.
```

## 상태

- 탄피: 전 구간 5회 연속 완주
- 탄두: 전 구간 **3회 연속 완주** (`settle()` 수정 후). 정렬 0.7~2.8px, 목표차 0.06mm 이내
- 깊이 검출: **쓰지 않는다.** 물체와 격자 리브가 같은 높이(285mm)라 원리적으로 안 갈린다.
  `MORPH_OPEN` 으로 리브를 침식하는 것도 교차점이 물체만큼 굵어 실패했다
- 미적용: Z 범위 게이트. 물체 281~283 / 오검출 298~323 / 손 170~220mm 로 분리된다
- 미해결: 검은 물체 미검출 / 루프 시 놓는 좌표가 고정이라 두 번째 물체가 쌓인다

## 사전 조건

```bash
ros2 launch realsense2_camera rs_launch.py align_depth.enable:=true
ros2 run fairino_hardware_v3_9_7 ros2_cmd_server
```

둘 다 하나씩만. 중복되면 로봇이 명령을 거부한다.
자세한 내용은 `SAM3/LEADME/비주얼서보잉-실기검증.md` 참고.
