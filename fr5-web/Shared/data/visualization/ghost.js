// 여러 관전자에서 같은 고스트를 고르는 한 줄 규칙 (API-CONTRACT §공동 시각화 고스트).
const joints = (v) => Array.isArray(v) && v.length >= 6 && v.slice(0, 6).every(Number.isFinite);

export function selectVisualGhost(snapshot, nowSec = Date.now() / 1000) {
  const target = snapshot?.motionTarget;
  if (target?.doneAt == null && joints(target?.jointsDeg)) {
    return { robotId: snapshot?.robotId ?? null, kind: 'target', jointsDeg: target.jointsDeg.slice(0, 6),
      gripperPct: null, seq: null, source: 'motionTarget' };
  }
  const shared = snapshot?.visualGhost;
  if (shared?.expiresAt > nowSec && joints(shared?.jointsDeg)) {
    return { robotId: shared.robotId, kind: shared.kind, jointsDeg: shared.jointsDeg.slice(0, 6),
      gripperPct: Number.isFinite(shared.gripperPct) ? shared.gripperPct : null,
      seq: shared.seq, source: 'visualGhost' };
  }
  return null;
}
