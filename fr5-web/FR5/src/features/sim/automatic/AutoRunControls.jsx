import { AUTO_STAGES, AUTO_STAGE_NAME } from './stages.js';

export function AutoRunControls({ automatic, limit, setLimit, confirmed, setConfirmed,
  start, stop, confirmPreview, startWhy }) {
  const active = automatic.status === 'RUNNING' || automatic.status === 'PREVIEW';
  return (
    <>
      <div className="row" data-t="sim-auto" data-status={automatic.status} data-stage={automatic.stage ?? ''}>
        <label>마지막 단계{' '}
          <select data-t="sim-auto-limit" value={limit} disabled={active}
            onChange={(e) => setLimit(e.target.value)}>
            {AUTO_STAGES.map(([id, label]) => <option key={id} value={id}>{id} {label}까지</option>)}
          </select>
        </label>
        <label className="confirm"><input type="checkbox" data-t="sim-auto-confirm" checked={confirmed} disabled={active}
          onChange={(e) => setConfirmed(e.target.checked)} /> 현장확인</label>
        <button type="button" className="big" data-t="sim-auto-start" disabled={!!startWhy}
          title={startWhy ?? ''} onClick={start}>
          자동 작업 시작 — {limit}에서 반드시 멈춤
        </button>
        <button type="button" className="stopbtn" data-t="sim-auto-stop" onClick={stop}>■ 즉시 정지</button>
      </div>
      {automatic.status === 'PREVIEW' && (
        <button type="button" className="big" data-t="sim-auto-preview-confirm" onClick={confirmPreview}>
          고스트 확인 · 집기 실행
        </button>
      )}
      <p className={`sentence ${automatic.status === 'FAILED' ? 'bad' : ''}`} data-t="sim-auto-status">
        {automatic.status === 'RUNNING'
          ? `자동 진행 중 — ${automatic.stage} ${AUTO_STAGE_NAME[automatic.stage]} · 완료 ${automatic.completed.join(' → ')}`
          : automatic.why ?? '마지막 단계를 고르고 현장확인 뒤 한 번 시작합니다. 중간 클릭 없이 그 단계에서 멈춥니다.'}
      </p>
    </>
  );
}
