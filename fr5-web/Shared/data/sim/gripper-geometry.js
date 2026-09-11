// 트윈과 MuJoCo가 같은 PGEA 손가락 개폐식을 쓴다. 0=닫힘, 100=열림.
export function gripperClosingMm(openPct, halfStrokeMm) {
  if (!Number.isFinite(openPct) || !Number.isFinite(halfStrokeMm)) return null;
  return ((100 - Math.min(100, Math.max(0, openPct))) / 100) * halfStrokeMm;
}

export function gripperFingerShiftMm(name, openPct, halfStrokeMm) {
  if (!String(name).includes('finger')) return 0;
  const closing = gripperClosingMm(openPct, halfStrokeMm);
  if (closing == null) return null;
  return (String(name).includes('left') ? -1 : 1) * closing;
}
