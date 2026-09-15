// 관제화면 번들 — PC 가 연다. **ar-threex(1.6MB)·카메라를 넣지 않는다** (BUILD-VITE.md).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripNotes } from '../Shared/build/strip-notes.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 시뮬 산출을 dev 서버가 정적으로 내준다 — `Sim/out/` → `/sim/`.
 *
 * **`publicDir` 를 두 개 둘 수 없어서** 미들웨어로 붙인다(`publicDir` 은 이미 Shared/assets).
 * 산출물은 커밋하지 않으므로(D14) 번들에 넣을 수도 없다 — **읽기 전용 dev 통로**다.
 *
 * ⛔ **경로 탈출을 막는다.** 요청 경로를 정규화한 뒤 `Sim/out` 밖으로 나가면 거부한다 —
 *    dev 서버라도 저장소 전체를 내주면 안 된다.
 * ⛔ **디렉터리 목록을 통째로 내주지 않는다.** `/sim/batches` 만 이름 배열을 낸다.
 */
function simOut() {
  const root = resolve(here, '../Sim/out');
  return {
    name: 'fr5-sim-out',
    configureServer(server) {
      server.middlewares.use('/sim', async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        if (rel === 'batches') {
          const { readdirSync, existsSync, statSync } = await import('node:fs');
          // **새로 구운 것이 앞에 온다** (2026-08-12). 이름순으로 내주면 화면이 기본으로
          // 고르는 것이 「마지막 이름」이 되는데, 그게 **없어진 슬롯의 옛 회차**였다 —
          // 픽스처를 다시 구운 날 그 배치가 첫 화면에 그대로 떠 있었다
          const list = existsSync(root)
            ? readdirSync(root, { withFileTypes: true })
              .filter((d) => d.isDirectory() && d.name !== 'scene' && !d.name.startsWith('_'))
              // ⚠ **폴더 mtime 으로 재지 않는다** — 파일을 덮어쓰기만 하면 폴더 시각이 안 바뀐다.
              //   같은 배치를 다시 구웠는데 목록에서 뒤로 남아 있었다 (2026-08-12 실측)
              .map((d) => {
                const at = (f) => { try { return statSync(resolve(root, d.name, f)).mtimeMs; } catch { return 0; } };
                return [d.name, Math.max(at('batch.json'), at('agg.json'))];
              })
              .sort((a, b) => b[1] - a[1])
              .map(([name]) => name)
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(list));
          return;
        }
        const abs = resolve(root, rel);
        if (!abs.startsWith(root + '/')) { res.statusCode = 403; res.end('경로 밖'); return; }
        const { existsSync, createReadStream } = await import('node:fs');
        if (!existsSync(abs)) return next();
        res.setHeader('Content-Type', abs.endsWith('.json') ? 'application/json' : 'text/plain');
        createReadStream(abs).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [stripNotes(), react(), simOut()],
  // 자산은 Shared/assets 하나뿐이다. 양쪽에 복사하지 않는다.
  // 대시보드도 URDF 를 쓴다 — 배치안에서 팔을 세우고 도달 범위를 본다.
  publicDir: resolve(here, '../Shared/assets'),
  server: { port: 5174 },   // AR(5173) 과 같이 띄울 수 있게
});
