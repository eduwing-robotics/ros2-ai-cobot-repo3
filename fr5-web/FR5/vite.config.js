// FR5 번들 — 팀원 노트북·폰이 연다. 빌드 산출물은 fr5-bridge 가 LAN 서빙한다 (API-CONTRACT §왜).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripNotes } from '../Shared/build/strip-notes.js';

const here = dirname(fileURLToPath(import.meta.url));
// 계약 경로는 /api 접두어가 없다 (API-CONTRACT). dev 는 경로별로 브리지에 넘긴다.
// **호스트를 밖에서 준다** (2026-08-13) — `AR/vite.config.js` 와 **같은 이름**을 쓴다.
// 로봇 랜선이 윈도우로 옮겨간 뒤(D112) 브리지는 `localhost` 가 아니라 다른 기계에 있다.
// 이게 없으면 dev 에서 **실기 값으로는 한 번도 못 보고 배포**하게 된다 — AR 에서 오늘
// 정확히 그 자리에 막혔고 같은 처방을 여기도 둔다.
//   FR5_BRIDGE=192.168.30.18:5055 npm run dev:fr5
const BRIDGE = `http://${process.env.FR5_BRIDGE || `localhost:${process.env.FR5_PORT ?? 5055}`}`;
// ⚠ 이 목록은 계약을 **손으로 미러링**한다 — 라우트를 늘리고 여기를 안 고치면 dev 에서만
// 조용히 404 가 난다 (2026-08-05 `/trajectories` 로 실제로 겪었다. 브리지는 200 인데 화면만 거부).
// `scripts/check/consts.sh` 가 이 목록을 main.py 의 라우트와 대조한다 — 손 미러링을 게이트가 받는다
// `/config` 는 라우트가 아니라 **정적 마운트**다 (계약 §정적 서빙) — 브리지가 보정값을
// 디스크에서 그대로 낸다. AR 은 브리지 없이도 돌아야 해서 자기 vite 가 직접 읽지만
// (`AR/vite.config.js` §configFiles), FR5 화면은 어차피 브리지가 있어야 뜬다.
const API_PATHS = ['/robots', '/connect', '/version', '/disconnect', '/state', '/owner',
  '/arm', '/disarm', '/points', '/trajectories', '/slots', '/preview', '/config', '/ik', '/follow', '/stop',
  '/sim', '/scan', '/runs'];   // `/sim/scene/<id>.xml` 정적 마운트(계약 §정적 서빙 · 09-06) · 2단 조준 스캔·단계 기록(§손목 스캔 · §단계 기록 · 09-07)
// ⚠ 주석은 `]` 뒤에만 — consts.sh 가 `[ … ]` 안을 정규식으로 읽어 프록시 목록을 대조한다(09-07 에 주석이 `]` 앞에 끼어 `/scan` 을 못 읽었다)

export default defineConfig({
  // 정적 자산은 Shared/assets 하나뿐이다. 복사하지 않는다 (AR 규칙 미러).
  publicDir: resolve(here, '../Shared/assets'),
  plugins: [stripNotes(), react()],
  base: './',
  // 엔트리 둘 — 조작 화면(`index.html`)과 허브(`hub.html` · 고리 일곱). 브리지가 둘 다 `/` 아래에서 낸다
  build: { rollupOptions: { input: { main: resolve(here, 'index.html'), hub: resolve(here, 'hub.html') } } },
  server: {
    host: true,
    port: 5176,             // AR(5173) · Dashboard(5174) · TB(5175) 와 같이 띄울 수 있게
    strictPort: true,       // 조용히 옆 포트로 밀리면 진단이 엉뚱한 서버를 가리킨다 (AR 실측)
    proxy: {
      ...Object.fromEntries(API_PATHS.map((p) => [p, BRIDGE])),
      '/ws': { target: BRIDGE.replace('http', 'ws'), ws: true },
    },
  },
});
