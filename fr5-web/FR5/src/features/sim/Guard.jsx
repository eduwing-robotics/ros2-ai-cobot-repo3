import React from 'react';

/** 렌더 오류 울타리 (2026-09-07 19:30 실기) — 조준 절의 값 하나(`rzB` null)가 `toFixed` 에서 터져 **화면 전체가 하얘졌다.**
 *  React 는 오류를 잡는 경계가 없으면 트리를 통째로 내린다. 여기서 잡아 그 절만 문장으로 바꾼다 — 다른 탭·STOP 은 살아 있어야 한다. */
export class Guard extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    console.error('[sim] 절 렌더 오류', err, info);
    // 다음 로드에서 읽을 수 있게 남긴다 (2026-09-07 20:58 실기 — ⑤a 스캔 성공 직후 화면이 통째로 죽었는데 콘솔을 못 봤다)
    try { window.sessionStorage.setItem('fr5.sim.lastError', JSON.stringify({ t: Date.now(), msg: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 1500), where: String(info?.componentStack ?? '').slice(0, 800) })); } catch { /* 없어도 된다 */ }
  }
  render() {
    if (this.state.err) {
      return (
        <p className="refusal" data-t="sim-guard">
          이 절을 그리다 오류가 났어요 — {String(this.state.err?.message ?? this.state.err).slice(0, 120)}
          {' '}<button type="button" onClick={() => this.setState({ err: null })}>다시 그리기</button>
        </p>
      );
    }
    return this.props.children;
  }
}
