// D36 경계 자리표시자 — FR5 조작·안전·조종권은 `FR5/`가 소유한다.
// Dashboard는 이후 읽기 전용 상태 요약과 FR5 앱 연결만 제공한다.

export function RobotControl() {
  return (
    <section>
      <h2>FR5 상태</h2>
      <p className="todo">FR5 조작 화면은 따로 있어요. 로봇에 붙어서 여기 대신 그쪽에서 움직여요.</p>
    </section>
  );
}
