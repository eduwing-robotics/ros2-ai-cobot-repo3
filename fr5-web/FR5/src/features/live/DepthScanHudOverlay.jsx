const point = (v) => (Array.isArray(v) && v.length >= 2
  && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))
  ? [Number(v[0]), Number(v[1])] : null);

export function DepthScanHudOverlay({ event, onLive }) {
  const result = event?.result;
  const view = result?.view;
  const frame = view?.frame;
  const target = point(view?.targetPx);
  const bullets = (view?.bulletsPx ?? []).map(point).filter(Boolean);
  const width = Number(frame?.widthPx);
  const height = Number(frame?.heightPx);
  const canDraw = result?.ok && width > 0 && height > 0;
  const rawAxis = view?.blob?.hullAxisDeg;
  const axis = rawAxis == null ? NaN : Number(rawAxis);
  const axisLen = Math.max(22, Math.min(width || 0, height || 0) * 0.09);
  const rad = Number.isFinite(axis) ? axis * Math.PI / 180 : null;
  const reason = (result?.reasons ?? [result?.reason]).filter(Boolean).join(' · ');

  return (
    <div className="depth-scan-overlay" data-t="depth-scan-overlay"
      data-ok={String(result?.ok === true)}>
      {canDraw && (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
          role="img" aria-label={`손목 뎁스 스캔 검출: 총알 ${bullets.length}개`}>
          {target && <g data-t="depth-scan-target" className="scan-target">
            <circle cx={target[0]} cy={target[1]} r="28" />
            <path d={`M ${target[0] - 38} ${target[1]} H ${target[0] + 38} M ${target[0]} ${target[1] - 38} V ${target[1] + 38}`} />
            {rad !== null && <path d={`M ${target[0] - Math.cos(rad) * axisLen} ${target[1] + Math.sin(rad) * axisLen} L ${target[0] + Math.cos(rad) * axisLen} ${target[1] - Math.sin(rad) * axisLen}`} />}
          </g>}
          {bullets.map(([x, y], i) => (
            <g key={`${x}-${y}-${i}`} data-t="depth-scan-bullet" className="scan-bullet">
              <circle cx={x} cy={y} r="15" />
              <circle cx={x} cy={y} r="7" />
              <text x={x + 19} y={y - 17}>{`총알 ${i + 1}`}</text>
            </g>
          ))}
        </svg>
      )}
      <div className="depth-scan-note" data-t="depth-scan-note">
        <span>{result?.ok
          ? `정지 스캔 · ${view?.target === 'carrier' ? '거치대' : view?.target ?? event?.target} · 총알 ${bullets.length}개`
          : `검출 실패${reason ? ` · ${reason}` : ''}`}</span>
        <button type="button" data-t="depth-scan-live" onClick={onLive}>실시간 보기</button>
      </div>
    </div>
  );
}
