// AR 번들 — 폰이 연다. **React·차트를 넣지 않는다** (BUILD-VITE.md §최상위 앱과 공용 경계).
import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { stripNotes } from '../Shared/build/strip-notes.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIAG_DIR = resolve(here, '../.diag');

/**
 * 폰이 보내는 진단 수치를 파일로 받는다 — `.diag/<날짜>.jsonl`
 *
 * **폰에는 콘솔이 없다** (AR-DEBUG.md §원칙). 그래서 지금까지 화면의 숫자를
 * 눈으로 읽어 옮겨 적는 수밖에 없었다. 그 손대는 구간에서 값이 틀어진다.
 *
 * `apply: 'serve'` 라 **배포 빌드에는 존재하지 않는다.** 보내는 쪽도
 * `import.meta.env.DEV` 로 감싸서 프로덕션 번들에서는 통째로 사라진다.
 * 그래서 이 구멍이 운영에 열릴 일이 없다.
 */
function diagSink() {
  return {
    name: 'fr5-diag-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__diag', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1e6) req.destroy();   // 흘러넘치는 요청은 끊는다
        });
        req.on('end', () => {
          try {
            mkdirSync(DIAG_DIR, { recursive: true });
            const day = new Date().toISOString().slice(0, 10);
            appendFileSync(resolve(DIAG_DIR, `${day}.jsonl`), `${body.trim()}\n`);
          } catch (e) {
            server.config.logger.warn(`[diag] 기록 실패: ${e.message}`);
          }
          res.statusCode = 204;
          res.end();
        });
      });
      server.config.logger.info(`  ➜  진단 로그:  .diag/<날짜>.jsonl  (?log=1 로 켠다)`);
    },
  };
}

/**
 * 보정값을 `/config/<이름>.json` 으로 **디스크에서 그대로** 낸다 (계약 §정적 서빙).
 *
 * 운영에서는 브리지가 같은 주소로 같은 폴더를 마운트한다 (`FR5/bridge/main.py`) —
 * **주소가 갈리면 dev 에서만 통과한다.**
 *
 * `publicDir` 에 넣지 않는 이유: publicDir 은 빌드 때 `dist` 로 **복사**된다.
 * 복사된 순간 그 값은 빌드 시점에 굳고, 그게 바로 없애려는 문제다 (2026-08-08 · 531mm).
 * AR 은 브리지 없이도 고정물로 돌아야 해서 프록시가 아니라 여기서 직접 읽는다.
 */
function configFiles() {
  const dir = resolve(here, '../Shared/data/config');
  return {
    name: 'fr5-config-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config', (req, res) => {
        // **`next()` 를 부르지 않는다** — 부르면 vite 의 html 폴백이 받아 `index.html` 을
        // **200 으로** 준다. 읽는 쪽은 `r.ok` 를 믿고 JSON 인 줄 알며, 브리지는 같은 자리에서
        // 404 를 내므로 **dev 에서만 다르게 답한다**(2026-08-08 실측에서 이 상태였다).
        // `/config` 는 우리 이름칸이니 여기서 끝낸다.
        const miss = () => { res.statusCode = 404; res.end('없다'); };
        // `..` 로 폴더 밖을 못 나가게 한다 — dev 서버는 `host: true` 라 랜에 열려 있다
        const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
        const file = resolve(dir, name);
        if (!/^[\w.-]+\.json$/.test(name) || !file.startsWith(dir)) { miss(); return; }
        let body;
        // **없으면 404 다 — 그게 정상이다.** 이 파일들은 `scripts/map/*.py` 의 산출물이라
        // 캘리브레이션 전에는 없고, 읽는 쪽이 그걸 "보정 없음"으로 읽는다
        try { body = readFileSync(file); } catch { miss(); return; }
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      });
    },
  };
}

export default defineConfig({
  // **상대 base** — 루트(Vercel)에서도, 브리지 하위경로(`:5055/ar/`)에서도 에셋이 풀린다
  // (FR5 와 같은 규약). 브리지가 AR 을 같은 출처에서 서빙해야 라이브 셀이 /ws/state 에 붙는다.
  base: './',
  // 정적 자산은 Shared/assets 하나뿐이다. 양쪽에 복사하지 않는다.
  publicDir: resolve(here, '../Shared/assets'),
  plugins: [stripNotes(), diagSink(), configFiles()],
  build: {
    rollupOptions: {
      // 화면마다 엔트리가 따로다. 랜딩(index)은 JS 가 없다.
      input: {
        index: resolve(here, 'index.html'),
        ar: resolve(here, 'ar.html'),
        robot: resolve(here, 'robot.html'),
        cam: resolve(here, 'cam.html'),
        xr: resolve(here, 'xr.html'),
        cell: resolve(here, 'cell.html'),
        markertest: resolve(here, 'test/marker-detect.html'),
        tagtrack: resolve(here, 'test/tag-track.html'),   // 폰 태그 정합 킬-실험 (2026-09-07)
      },
    },
  },
  server: {
    host: true,             // 폰에서 로컬 확인할 때 필요하다
    // 라이브 미러가 붙는 브리지 상태 소켓을 same-origin 으로 넘긴다 (FR5 vite 미러).
    // 폰이 HTTPS(카메라)라 평문 브리지(`ws://…:5055`)를 직접 가리키면 혼합 콘텐츠로 막힌다 —
    // 여기서 프록시하면 폰은 same-origin `wss` 로 붙고 vite 가 브리지로 넘긴다.
    // **브리지는 원격일 수 있다** — 랩 우분투에 실기가 붙어 dev 는 노트북에서 도는 식이라
    // localhost 가정이면 못 닿는다. `FR5_BRIDGE=host:port` 로 대상을 준다(기본 localhost:FR5_PORT).
    // 예: `FR5_BRIDGE=192.168.30.240:5055 npm run dev:ar`. `?bridge=` 없이 이 경로가 동작한다.
    proxy: {
      '/ws': {
        target: `ws://${process.env.FR5_BRIDGE || `localhost:${process.env.FR5_PORT ?? 5055}`}`,
        ws: true,
      },
      // 판정면 겹치기는 **브리지 값 없이는 아무것도 안 그린다** (`GOAL-cam-zone-overlay`).
      // 운영에서는 브리지가 `/ar` 을 서빙해 같은 출처지만(계약 §정적 서빙), dev 는 Vite 라
      // `/state` 가 404 다 — 그러면 **실기 값으로는 한 번도 못 보고 배포**하게 된다.
      // 2026-08-13 에 실제로 여기서 막혔다. `FR5_BRIDGE=192.168.30.18:5055 npm run dev -w @fr5/ar`.
      //
      // ⚠ **`/config` 는 프록시하지 않는다** (아래 미들웨어가 레포 것을 낸다). 캘리브레이션은
      // 여기서 풀어 여기 쓰는 값이라, 브리지로 보내면 **방금 푼 값이 아니라 호스트에 배포된
      // 옛 값**으로 겹친다. 08-13 에 실제로 그랬다 — 레포는 remount8 인데 호스트는 remount6.
      '/state': {
        target: `http://${process.env.FR5_BRIDGE || `localhost:${process.env.FR5_PORT ?? 5055}`}`,
        changeOrigin: true,
      },
    },
    // **포트를 고정하고 밀리면 실패시킨다.** 기본 5173 은 다른 프로젝트와 자주 부딪히는데,
    // Vite 는 조용히 다음 포트로 옮겨간다. 그러면 `adb reverse` 도 진단 로그도
    // 엉뚱한 서버를 가리키고 — 실제로 남의 dev 서버에 POST 해서 404 를 받았다.
    port: 5173,
    strictPort: true,
  },
});
