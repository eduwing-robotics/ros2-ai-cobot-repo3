# SAM 3 설치·인증·실행 가이드 (이 PC 기준)

> 대상 장비: RTX 5060 8GB / Ubuntu / Python 3.12
> 작성일: 2026-09-07
> 개념 설명과 API 레퍼런스는 [sam3-사용법.md](sam3-사용법.md) 참조. 이 문서는 **이 PC에서 실제로 돌리는 절차**만 다룬다.

---

## 0. 현재 상태 — 검증 완료

2026-09-07 이 PC에서 설치·인증·추론까지 전부 확인했다.

| 항목 | 상태 |
|---|---|
| 오버레이 venv `~/sam3_env` | 완료 |
| torch 2.11.0+cu130 (sm_120) | 완료 (lerobot 환경에서 상속) |
| transformers 5.16.1 | 완료 |
| HF CLI 인증 (`ENONE31`) | 완료 |
| 게이트 승인 | 완료 (제출 후 약 10분) |
| 가중치 `facebook/sam3` | 다운로드 완료 (캐시 6.5G) |
| 텍스트 / 박스 / 네거티브 박스 추론 | 동작 확인 |
| 비디오 추론 + 트래킹 | 동작 확인 (프레임 수 제약 있음) |

### 실측값 (RTX 5060 8GB, bf16, 단일 이미지)

| 항목 | 값 |
|---|---|
| 파라미터 | 0.84B |
| 모델 로드 | 14.4s |
| 추론 (warm) | 약 300ms |
| **피크 VRAM** | **2.00 GiB** |

**문서 권장치 24GB는 단일 이미지 추론에는 과하다.** bf16으로 올리면 8GB GPU에서 여유가 크고, 해상도 축소도 필요 없었다. 24GB는 비디오나 대량 객체 기준으로 보인다.

## 1. 환경 구성 방식과 그 이유

### 왜 새 conda 환경을 만들지 않았나

이 PC는 디스크 여유가 14GB뿐이다(159GB 중 91% 사용). torch + CUDA 휠을 새로 받으면 6~7GB, 여기에 SAM 3 가중치 3.4GB가 더해져 여유가 거의 사라진다.

동시에 `lerobot` conda 환경에는 이미 조건에 맞는 torch가 있다.

- torch 2.11.0+cu130
- `get_arch_list()`에 `sm_120` 포함 — RTX 5060(Blackwell)에 필수
- Python 3.12.14

하지만 이 환경은 FR5 정규 환경이라 **직접 패키지를 추가하면 안 된다.** transformers 설치가 의존성 해석 과정에서 lerobot 관련 버전을 건드릴 위험이 있다.

### 채택한 방법: 오버레이 venv

lerobot 환경의 파이썬으로 `--system-site-packages` venv를 만든다. 이러면 torch는 lerobot 쪽을 **읽기만** 하고, 새로 설치하는 패키지는 오버레이에만 들어가 lerobot의 것을 가린다. lerobot 환경 자체는 쓰기가 일어나지 않는다.

```bash
/home/kimsunil/miniforge3/envs/lerobot/bin/python -m venv --system-site-packages ~/sam3_env
~/sam3_env/bin/pip install -U "transformers>=5.0.0" "huggingface_hub[cli]"
```

**주의**: 베이스 파이썬을 잘못 고르면 실패한다. `~/ai_env`는 그 자체가 venv라서, 그 파이썬으로 `--system-site-packages`를 주면 lerobot이 아니라 `/usr/bin` 쪽을 상속해 torch를 못 찾는다. 반드시 conda 환경의 파이썬을 쓴다.

### 격리가 유지됐는지 확인

```bash
~/sam3_env/bin/python -c "import huggingface_hub as h; print(h.__version__, h.__file__)"
# 1.30.0  ~/sam3_env/lib/.../huggingface_hub/__init__.py     ← 오버레이

/home/kimsunil/miniforge3/envs/lerobot/bin/python -c "import huggingface_hub as h; print(h.__version__, h.__file__)"
# 1.29.0  ~/miniforge3/envs/lerobot/lib/.../huggingface_hub/__init__.py   ← 원본 그대로
```

설치 중 다음 경고가 나오지만 무시해도 된다. 상속된 lerobot 패키지들에 원래 있던 충돌을 pip가 보고하는 것이고, lerobot 환경에 변경은 없다.

```
lerobot-robot-ros 0.1.0 requires lerobot<0.5.0,>=0.4.0, but you have lerobot 0.6.1
```

---

## 2. HF 인증 — 막힌 지점과 해결

### 왜 막히는가

`facebook/sam3`는 `gated: manual` 저장소다. `config.json` 한 줄조차 인증 없이는 401이 난다.

```
OSError: You are trying to access a gated repo.
Cannot access gated repo for url https://huggingface.co/facebook/sam3/resolve/main/config.json
```

**중요: 두 단계가 서로 별개다.**

1. **게이트 승인** — 웹에서 Request access → Meta가 수동 승인. 계정에 권한이 붙는다.
2. **CLI 인증** — 이 PC의 파이썬이 그 계정으로 로그인. 토큰이 디스크에 저장된다.

웹에서 승인만 받고 2번을 안 하면 다운로드는 계속 401이다. 실제로 이 PC에서 그 상태가 발생했다.

### 인증 여부 확인법

```bash
~/sam3_env/bin/hf auth whoami
```

- `Error: Not logged in` → 미인증
- 사용자명 출력 → 인증됨

파일로도 확인할 수 있다. 인증이 되면 아래 두 파일이 생긴다. 없으면 로그인이 안 된 것이다.

```bash
ls -la ~/.cache/huggingface/token ~/.cache/huggingface/stored_tokens
```

### 로그인 방법 — 디바이스 코드 플로우

huggingface_hub 1.30부터 `hf auth login`은 토큰 붙여넣기가 아니라 **브라우저 디바이스 인증**을 쓴다. 실행하면 이런 출력이 나온다.

```
Ask the user to open https://hf.co/oauth/device in a browser
and enter the code XXXX-XXXX. The code expires in 300 seconds.
Waiting for authorization...
```

절차:

1. 브라우저에서 https://hf.co/oauth/device 를 연다
2. 화면에 뜬 8자리 코드를 입력하고 승인한다
3. 터미널의 `Waiting for authorization...`이 성공으로 바뀐다

**제약 두 가지.**

- **코드 유효시간이 300초다.** 넘기면 처음부터 다시 실행해야 한다.
- **이 명령은 대화형이라 Claude의 Bash 도구로 돌리면 안 된다.** 도구는 120초에 타임아웃되어 백그라운드로 넘어가고, 그 사이 코드가 만료되기 쉽다. 실제로 그렇게 한 번 실패했다.

따라서 **일반 터미널 창을 직접 열어서** 실행하는 것이 가장 확실하다.

```bash
~/sam3_env/bin/hf auth login
```

### 대안: 토큰을 파일로 직접 넣기

디바이스 플로우가 안 될 때 쓴다. https://huggingface.co/settings/tokens 에서 **Read** 권한 토큰을 발급한 뒤, 라이브러리가 읽는 경로에 저장한다.

```bash
mkdir -p ~/.cache/huggingface
# 편집기로 열어 토큰 한 줄만 저장 (따옴표·개행 없이)
nano ~/.cache/huggingface/token
chmod 600 ~/.cache/huggingface/token
~/sam3_env/bin/hf auth whoami   # 확인
```

또는 세션 한정으로 환경변수를 쓴다.

```bash
export HF_TOKEN=<토큰>
```

**보안**: 토큰을 채팅창이나 Claude 프롬프트의 `!` 명령에 붙여넣지 않는다. 대화 기록에 평문으로 남는다. 편집기나 디바이스 플로우를 쓰면 기록에 남지 않는다.

---

## 3. 사용법

### 3.1 기본형

```bash
cd ~/sam3_test
~/sam3_env/bin/python run_sam3.py --image cats.jpg --prompt cat
```

출력은 다음과 같다.

```
[load] 14.4s  params=0.84B  dtype=bfloat16  dev=cuda
[img ] cats.jpg (640, 425)  text='cat'
[infer] 301ms (warm)
[result] 1 object(s)
   #0  score=0.977  box=[230,86,524,420]
[vram] peak 2.00 GiB
[saved] out_cats_cat.png
```

마스크를 색으로 덮고 박스와 score를 그린 PNG가 저장된다.

### 3.2 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--image` | `cats.jpg` | 입력 이미지 경로 |
| `--prompt` | `cat` | 텍스트 프롬프트. `none` 이면 텍스트 없이 박스만 사용 |
| `--box` | 없음 | positive 박스 `x1,y1,x2,y2`. 여러 번 지정 가능 |
| `--neg-box` | 없음 | 제외할 영역. 형식은 `--box` 와 같음 |
| `--threshold` | 0.5 | 객체 신뢰도 임계값 |
| `--mask-threshold` | 0.5 | 마스크 이진화 임계값 |
| `--image-size` | 0 (기본 해상도) | 낮추면 VRAM 절약 |
| `--dtype` | `bfloat16` | `float16` / `float32` |
| `--out` | 자동 생성 | 결과 PNG 경로 |

### 3.3 세 가지 프롬프트 방식

**(a) 텍스트 — 개념에 해당하는 모든 인스턴스**

짧은 명사구를 쓴다. 같은 개념이 여러 개면 전부 개별 인스턴스로 나온다. 이것이 SAM 3의 핵심인 PCS다.

```bash
~/sam3_env/bin/python run_sam3.py --image kitchen.jpg --prompt dial
# → 7 object(s)  (레인지 노브 5 + 좌측 스위치 + 오븐 내부 1)

~/sam3_env/bin/python run_sam3.py --image twocats.jpg --prompt "remote control"
# → 2 object(s)  score 0.98 / 0.97
```

`"the cat on the left"` 같은 관계·문장형 표현은 대상이 아니다. 형용사+명사까지가 안전하다.

**(b) 박스 exemplar — 예시를 보여주고 같은 것 찾기**

이름을 모르는 부품에 유용하다. 하나만 찍어주면 나머지를 찾아낸다.

```bash
~/sam3_env/bin/python run_sam3.py --image kitchen.jpg --prompt none --box 59,144,76,163
# → 6 object(s)  제시한 다이얼(0.969) + 같은 종류 5개
```

**(c) 텍스트 + 네거티브 박스 — 오검출 제거**

실무에서 가장 자주 쓰게 되는 조합이다.

```bash
~/sam3_env/bin/python run_sam3.py --image kitchen.jpg --prompt handle
# → 6 object(s)   (오븐 손잡이까지 포함)

~/sam3_env/bin/python run_sam3.py --image kitchen.jpg --prompt handle --neg-box 40,183,318,204
# → 3 object(s)   (오븐 손잡이 제외)
```

### 3.4 검출 개수 조정

너무 많이/적게 잡히면 `--threshold` 를 조정한다. 프롬프트를 바꾸는 것보다 먼저 시도할 값이다.

```bash
--threshold 0.3   # 더 많이 (기본 API 기본값)
--threshold 0.7   # 확실한 것만
```

### 3.5 내 코드에 가져다 쓰기

스크립트 없이 직접 쓸 때의 최소 형태다.

```python
import torch
from PIL import Image
from transformers import Sam3Model, Sam3Processor

model = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to("cuda").eval()
proc = Sam3Processor.from_pretrained("facebook/sam3")

image = Image.open("myimage.jpg").convert("RGB")
inputs = proc(images=image, text="screw", return_tensors="pt").to("cuda")

with torch.no_grad():
    outputs = model(**inputs)

res = proc.post_process_instance_segmentation(
    outputs, threshold=0.5, mask_threshold=0.5,
    target_sizes=inputs.get("original_sizes").tolist(),
)[0]

masks, boxes, scores = res["masks"], res["boxes"], res["scores"]
```

**모델은 한 번만 로드한다.** 로드가 14초, 추론이 0.3초라 이미지마다 로드하면 50배 손해다. 여러 이미지를 처리할 때는 모델을 밖에서 만들고 루프 안에서는 추론만 돈다.

**박스 프롬프트를 bf16/fp16과 함께 쓸 때는 캐스팅이 필요하다** (아래 3.6 참조).

### 3.6 알려진 버그 — 박스 프롬프트 + bf16

transformers 5.16.1 기준, 박스 좌표는 float32로 나오는데 모델이 bf16이면 dtype이 어긋난다.

```
RuntimeError: mat1 and mat2 must have the same dtype, but got Float and BFloat16
```

프로세서 출력 직후 캐스팅하면 해결된다. `run_sam3.py` 에는 이미 반영돼 있다.

```python
inputs = proc(images=image, input_boxes=..., return_tensors="pt").to("cuda")
if "input_boxes" in inputs and inputs["input_boxes"] is not None:
    inputs["input_boxes"] = inputs["input_boxes"].to(torch.bfloat16)
```

float32로 돌리면 이 문제는 없지만 VRAM을 두 배 쓴다.

## 4. 비디오 추론

`~/sam3_test/run_sam3_video.py` 를 쓴다. 텍스트 프롬프트로 개념을 지정하면 해당 인스턴스를 전부 찾아 프레임 간 ID를 유지하며 추적한다.

### 4.1 기본형

```bash
cd ~/sam3_test
~/sam3_env/bin/python run_sam3_video.py --video bedroom.mp4 --prompt person --max-frames 100
```

```
[track] 100 frames  50.2s  (502ms/frame)
[vram] peak 2.77 GiB
[objs] 'person': 2 object(s)  ids=[0, 1]
[counts] 0:2 8:2 16:2 ... 96:2
```

`counts` 가 전 구간 일정하면 트래킹이 끊기지 않은 것이다.

### 4.2 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--video` | `bedroom.mp4` | 입력 영상 |
| `--prompt` | `person` | 쉼표로 여러 개: `person,pillow,bed` |
| `--max-frames` | 30 | 처리할 프레임 수. **RAM 제약의 핵심 변수** |
| `--save-every` | 10 | N프레임마다 PNG 저장 |
| `--out-dir` | `video_out` | 결과 디렉터리 |
| `--dtype` | `bfloat16` | 모델 dtype |
| `--image-size` | 0 | 해상도 축소 |

### 4.3 다중 프롬프트

```bash
~/sam3_env/bin/python run_sam3_video.py --video bedroom.mp4 \
  --prompt "person,pillow,bed" --max-frames 60
```

```
[objs] 'person': 2 object(s)  ids=[0, 1]
[objs] 'pillow': 6 object(s)  ids=[2, 3, 4, 5, 6, 7]
[objs] 'bed':    1 object(s)  ids=[8]
```

`prompt_to_obj_ids` 로 어떤 프롬프트가 어떤 ID를 만들었는지 역추적한다. ID는 프롬프트를 가로질러 전역으로 부여된다.

### 4.4 함정 1 — `init_video_session` 의 dtype 기본값

**HF 문서 예제에 이 인자가 빠져 있다.** `dtype` 기본값이 `torch.float32` 라서, 모델을 bf16으로 올리면 트래커 conv에서 그대로 터진다.

```
RuntimeError: Input type (float) and bias type (c10::BFloat16) should be the same
```

반드시 모델 dtype과 맞춘다.

```python
session = proc.init_video_session(
    video=frames,
    inference_device="cuda",
    processing_device="cpu",
    video_storage_device="cpu",
    dtype=torch.bfloat16,      # ← 모델과 일치시킬 것
)
```

이미지 쪽의 박스 프롬프트 dtype 버그(3.6절)와는 다른 별개 문제다.

### 4.5 함정 2 — 병목은 RAM이다

200프레임을 돌리면 `exit 137` 로 죽는다. CUDA OOM 에러가 아니라 커널의 OOM killer다.

```bash
journalctl -k | grep -i oom-kill
# oom-kill:... task=python ...  Out of memory: Killed process (python)
```

VRAM은 3.92 GiB로 8GB에 여유가 있는데 시스템 RAM이 먼저 터진다. 이 PC는 15GB 중 약 9.7GB를 이미 쓰고 있고(Firefox만 2.3GB+) **swap 4GB가 완전히 소진된 상태**라, 가용 5.7GB로는 200프레임 세션을 못 버틴다.

**실용 한계**

| 조건 | 한계 |
|---|---|
| 단일 프롬프트 | 약 100프레임 |
| 다중 프롬프트(객체 9개) | 약 60프레임 |

**늘리는 방법** — 위에서부터 효과가 크다.

1. 브라우저를 닫는다 (2~3GB 회복)
2. `--max-frames` 를 나눠서 구간별로 처리한다
3. swap을 늘린다
4. **스트리밍 모드로 전환한다** — 객체가 적으면 가장 효과적이다. 단 만능은 아니다. 4.7절
5. `--image-size 560` 으로 해상도를 낮춘다

스크립트는 프레임마다 마스크를 즉시 소비하고 버린다. 직접 짤 때 결과를 전부 dict에 쌓으면 RAM이 훨씬 빨리 터지니 주의한다.

### 4.6 마스크 품질 — `kernels` 설치

없으면 다음 경고와 함께 NMS 후처리, 구멍 메우기, 잔점 제거가 통째로 스킵된다.

```
kernels library is not installed. NMS post-processing, hole filling,
and sprinkle removal will be skipped.
```

```bash
~/sam3_env/bin/pip install kernels    # 설치 완료됨
```

### 4.7 스트리밍 모드 — 언제 이득인가

`~/sam3_test/run_sam3_stream.py` 를 쓴다. `init_video_session` 에 `video=` 를 **주지 않고** 프레임을 하나씩 넣는다. 스크립트는 PyAV로 한 장씩 디코딩하므로 영상 전체가 메모리에 올라가지 않는다.

```bash
~/sam3_env/bin/python run_sam3_stream.py --video bedroom.mp4 --prompt person --max-frames 200
```

```python
session = proc.init_video_session(            # video= 없음
    inference_device="cuda", processing_device="cpu",
    video_storage_device="cpu", dtype=torch.bfloat16,
)
proc.add_text_prompt(session, "person")

for frame in stream:                          # 카메라든 디코더든
    inputs = proc(images=frame, device="cuda", return_tensors="pt").to("cuda")
    with torch.no_grad():
        mo = model(inference_session=session,
                   frame=inputs.pixel_values[0].to(torch.bfloat16), reverse=False)
    out = proc.postprocess_outputs(session, mo, original_sizes=inputs.original_sizes)
```

`pixel_values` 도 모델 dtype으로 캐스팅해야 한다. 4.4절과 같은 이유다.

**측정 결과 — 이득이 있는 경우와 없는 경우가 갈린다.**

| 조건 | pre-loaded | 스트리밍 | 판정 |
|---|---|---|---|
| `person`, 200프레임 | RAM OOM | **OK** (459ms/f) | 스트리밍 완승 |
| 다중 프롬프트(9객체), 60프레임 | OK (945ms/f) | OK (964ms/f) | 무승부 |
| 다중 프롬프트, 90프레임 이상 | RAM OOM | **CUDA OOM** | 둘 다 실패 |

**객체가 많으면 스트리밍도 답이 아니다.** 실패 원인이 RAM에서 VRAM으로 바뀔 뿐이다. 트래커 메모리 뱅크가 객체 수에 비례해 GPU에서 자라기 때문이고, `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` 로도 해결되지 않는다. 단편화가 아니라 실사용량 문제다.

**품질은 실제로 떨어진다.** 같은 영상·같은 프롬프트·같은 60프레임에서 검출 수 추이가 갈렸다.

```
pre-loaded : 0:9  10:9  20:9  30:9  35:9   40:9   50:9   55:9
스트리밍   : 0:9  10:9  20:9  30:9  35:10  40:10  50:10  55:10
```

35프레임 부근에서 없던 10번째 트랙이 생겨 끝까지 남는다. 사람에 가려졌다 나오는 영역을 새 객체로 잘못 잡은 것으로, 미래 프레임 기반 휴리스틱이 꺼진 결과다. **ID 안정성이 중요한 작업에는 pre-loaded를 쓴다.**

### 4.8 어느 쪽을 쓸 것인가

| 상황 | 선택 |
|---|---|
| 긴 영상 + 적은 객체 | **스트리밍** — 유일하게 되고 속도도 낫다 |
| 짧은 영상 + 많은 객체 | **pre-loaded** — ID가 안정적이다 |
| 실시간 카메라 입력 | **스트리밍** — 선택지가 없다 |
| 긴 영상 + 많은 객체 | 이 PC에선 둘 다 실패. 구간 분할 또는 `--image-size` 축소 |

## 5. 이 PC의 VRAM 제약

**실측 결과 단일 이미지 추론은 문제가 없었다.** bf16 기준 피크 2.00 GiB로, 8GB GPU에서 충분히 여유롭다. 아래 대응책은 비디오나 대량 객체처럼 더 무거운 경우를 위한 것이다.

**단계별 대응** — 위에서부터 시도한다.

1. bf16 로드 (스크립트 기본값)
2. 해상도 축소 — config와 processor를 **함께** 낮춰야 한다. 스크립트의 `--image-size`가 둘 다 처리한다.
   ```bash
   ~/sam3_env/bin/python run_sam3.py --image cats.jpg --prompt cat --image-size 560
   ```
3. 더 줄이려면 `--image-size 448`
4. GPU 메모리 확보 — 브라우저 등 GPU를 쓰는 프로그램을 닫는다
   ```bash
   nvidia-smi --query-gpu=memory.free --format=csv
   ```
5. 최후 수단으로 CPU 추론. 동작은 하지만 실용 속도가 아니다

비디오 추론은 8GB에서 훨씬 빡빡하다. 시도한다면 `processing_device="cpu"`, `video_storage_device="cpu"`를 반드시 주고 `max_frame_num_to_track`을 작게 잡는다.

---

## 6. 문제 해결

| 증상 | 원인 / 조치 |
|---|---|
| `Not logged in` | 2장의 로그인 절차 수행 |
| `GatedRepoError` / 401 | 웹 게이트 승인과 CLI 로그인 중 하나가 빠짐. 둘 다 확인 |
| 로그인 명령이 120초 타임아웃 | Claude Bash 도구로 대화형 명령을 실행함. 일반 터미널에서 직접 실행 |
| 디바이스 코드가 안 먹힘 | 300초 만료. 명령을 다시 실행해 새 코드를 받는다 |
| `ModuleNotFoundError: torch` (오버레이 생성 시) | 베이스 파이썬을 conda의 lerobot 것으로 지정했는지 확인 |
| `CUDA out of memory` | 4장의 1→2→3→4 순서로 대응 |
| `sm_120 is not compatible` | torch가 Blackwell 미지원 빌드. `get_arch_list()`에 `sm_120` 있는지 확인 |
| 마스크 크기가 원본과 다름 | `post_process_instance_segmentation`에 `target_sizes` 전달 누락 |
| 검출 0개 | `--threshold` 를 0.3 등으로 낮춘다. 프롬프트를 더 일반적인 명사구로 바꾼다 |
| 디스크 부족 | 가중치 캐시는 `~/.cache/huggingface/hub`. `hf cache scan` / `hf cache delete` 로 정리 |
| 비디오에서 `exit 137` / `Killed` | CUDA OOM이 아니라 **시스템 RAM** OOM. `--max-frames` 축소, 브라우저 종료, 스트리밍 전환. 4.5·4.7절 |
| 스트리밍에서 `torch.OutOfMemoryError` | 이쪽은 진짜 VRAM. 객체 수가 많으면 스트리밍도 못 버틴다. 프레임 분할 또는 `--image-size` 축소. 4.7절 |
| 스트리밍 결과에 없던 객체가 생김 | 정상 동작. 미래 프레임 휴리스틱이 꺼진 탓이다. ID 안정성이 필요하면 pre-loaded. 4.7절 |
| `Input type (float) and bias type (BFloat16)` | `init_video_session(dtype=...)` 를 모델 dtype과 맞춘다. 4.4절 |
| `mat1 and mat2 must have the same dtype` | 박스 프롬프트 + bf16. `inputs["input_boxes"]` 캐스팅. 3.6절 |
| 마스크에 구멍·잔점이 많음 | `pip install kernels`. 4.6절 |

---

## 7. 정리(rollback)

이 작업이 만든 것은 다음 넷뿐이다. lerobot 환경과 시스템 파이썬은 변경되지 않았다.

```bash
rm -rf ~/sam3_env      # 오버레이 venv
rm -rf ~/sam3_test     # 테스트 이미지 + 스크립트
~/sam3_env/bin/hf cache delete   # 가중치 캐시 (삭제 전 실행)
# ~/.cache/huggingface/token 은 다른 HF 작업에도 쓰이므로 필요할 때만 삭제
```

---

## 8. 남은 것

이미지 추론, 비디오 추론(pre-loaded), 스트리밍 추론은 검증이 끝났다. 아직 확인하지 않은 것은 다음과 같다.

- **배치 이미지 추론** — 여러 장을 한 번에. 같은 문서 4.4절
- **임베딩 재사용** — 같은 이미지에 프롬프트만 바꿀 때 `get_vision_features()` 로 vision 임베딩을 한 번만 계산. 같은 문서 6.1절
- **`torch.compile` / FP16** — 300ms를 더 줄일 여지
