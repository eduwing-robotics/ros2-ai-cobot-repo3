// 이동 속도 고르기 — Teach 「이동」 과 Program 「n단계 실행」 이 **같이 쓴다.**
//
// **한 곳에 둔 이유는 값이 둘로 갈리지 않게 하려는 것이다.** 상한 10% 는 하드 룰 3 이고
// 서버가 `safety.check_motion` 에서 다시 본다 — 여기 목록은 편의지 안전장치가 아니다.
//
// **조그에는 안 붙인다.** 한 걸음이 1° 면 10% 에서 56ms 라 속도를 낮춰도 사람 눈에 차이가
// 없다. 값이 살아나는 곳은 수십 도를 한 번에 가는 **지점 이동**이다 — 처음 만든 지점을
// 처음 눌러 볼 때가 제일 위험한 순간인데 거기가 고정 10% 였다.
//
// 왜 1% 가 없나 — 서버는 1 까지 받지만(계약 §경로 검사), 30° 를 1% 로 가면 16.7초다.
// 브리지의 정착 대기 상한이 6초라 그 뒤에 누르는 명령이 「아직 움직이는 중」 으로 거부된다.
// 3% 는 30° 를 5.6초에 가서 그 상한 안이다. 못 쓰는 값을 목록에 넣지 않는다.
export const SPEED_CAP_PCT = 10;              // 하드 룰 3 · `safety.SPEED_CAP_PCT` 와 같은 값
export const SPEED_CHOICES = [3, 5, SPEED_CAP_PCT];

export function SpeedPick({ value, onChange, disabled = false }) {
  return (
    <label className="speedpick" data-t="speed-pick">
      속도
      <select value={value} disabled={disabled} data-t="speed-pick-select"
        onChange={(e) => onChange(Number(e.target.value))}>
        {SPEED_CHOICES.map((v) => (
          <option key={v} value={v}>{v}%{v === SPEED_CAP_PCT ? ' (상한)' : ''}</option>
        ))}
      </select>
    </label>
  );
}
