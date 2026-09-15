// 맵 편집기 엔트리. **탭이면 된다 — 라우터를 넣지 않는다** (CONSOLE-REACT.md §의존성).
//
// 지금은 골격이다. 세 기능이 각각 언제 살아나는지는 그 파일 머리에 적어 뒀다.
// 여기서 보증하는 것은 하나 — **React + Vite + @fr5/shared 배선이 실제로 된다.**

import './main.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FR5_REACH_M } from '@fr5/shared/view3d/reach-zone.js';
import { datasource } from '@fr5/shared/data/datasource/index.js';
import { LayoutEditor } from '../features/layout/LayoutEditor.jsx';
import { MetricsCompare } from '../features/metrics/MetricsCompare.jsx';
import { RobotControl } from '../features/control/RobotControl.jsx';
import { SimTab } from '../features/sim/SimTab.jsx';

const TABS = [
  ['layout', '배치안', LayoutEditor],
  ['metrics', '생산성 비교', MetricsCompare],
  // **시뮬은 `생산성 비교` 에 안 얹는다** (D109) — 그쪽은 팀원 지표 몫이라 섞으면
  // 그 데이터가 도착하는 날 둘을 다시 뜯는다
  ['sim', '시뮬', SimTab],
  ['control', '로봇 조작', RobotControl],
];

// 출처. **여기 문자열을 박지 않는다** — datasource 가 자기가 무엇인지 말한다.
// 박아 두면 `http.js` 로 바꿔 끼운 날 화면이 계속 "mock" 이라고 우긴다 (SR_24).
const SOURCE = datasource.source;

function App() {
  const [tab, setTab] = useState('layout');
  const Active = TABS.find(([id]) => id === tab)[2];
  return (
    <>
      <header>
        <h1>FR5 맵 편집기</h1>
        <span className="sub">배치안 편집 · 생산성 비교 — 도달거리 {FR5_REACH_M * 1000}mm</span>
        {/* 출처 배지는 항상 보인다. 목업을 실측으로 착각한 채 보고하는 것이 가장 비싼 사고다 */}
        <span className="source" data-src={SOURCE}>출처 {SOURCE}</span>
      </header>
      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <main><Active /></main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);

// 헤드리스 검증용 노출 — AR 과 같은 방식이다 (evidence/2026-07-30-ar-baseline.md).
Object.assign(window, { FR5_REACH_M, SOURCE, TABS: TABS.map(([id]) => id) });
