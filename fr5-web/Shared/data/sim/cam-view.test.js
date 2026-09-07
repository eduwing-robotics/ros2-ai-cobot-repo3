// 글로벌캠 시야 예측 — 실측 파일(보정 · 덱 태그 4 · 앵커 5 · 터틀봇 태그)에 대는 검사 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cameraPosMm, projectCamLab, tagPx, tagVisibility, frustumCamLab } from './cam-view.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const J = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const calib = J('Shared/data/config/global-cam.json');
const layout = J('calib-shots/tag-layout.json');
const anchors = J('Shared/data/config/scene-anchors.json').anchors;
// amr-pose.json 은 브리지가 1초마다 덮어쓰는 런타임 파일이라 커밋되지 않는다 — 없으면 그 검사만 건너뛴다
const AMR_P = 'Shared/data/config/amr-pose.json';
const amr = existsSync(join(ROOT, AMR_P)) ? J(AMR_P).anchors['18'] : null;
const needAmr = { skip: amr ? false : `${AMR_P} 없음 — 브리지가 돌 때만 생긴다` };

test('카메라 자리 = −Rᵀt — 보정 파일의 camPosMm 과 1mm 안', () => {
  const c = cameraPosMm(calib);
  const e = calib.labToCam.camPosMm;
  assert.ok(Math.hypot(c[0] - e[0], c[1] - e[1], c[2] - e[2]) < 1, `${c} vs ${e}`);
  assert.ok(Math.abs(c[2] - calib.labToCam.heightMm) < 1);
});

test('보정에 쓴 덱 태그 4장은 전부 카메라 앞·영상 안에 찍힌다 (145mm 라 100px 넘게)', () => {
  for (const [id, t] of Object.entries(layout.tags)) {
    const pr = projectCamLab(calib, [t.xMm, t.yMm, t.zMm]);
    assert.ok(pr && pr.inImage, `태그 ${id} 가 영상 밖 — ${JSON.stringify(pr)}`);
    assert.ok(tagPx(calib, pr.depthMm, layout.tagSizeMm) > 100, `태그 ${id} ${pr.depthMm}mm`);
  }
});

test('같은 카메라가 푼 앵커 5개도 영상 안이다 — 밖이면 rvec/tvec 해석이 틀린 것', () => {
  for (const [id, a] of Object.entries(anchors)) {
    const pr = projectCamLab(calib, a.labMm);
    assert.ok(pr && pr.inImage, `앵커 ${id} — ${JSON.stringify(pr)}`);
  }
});

test('터틀봇 태그(84mm · 홈 부근 실측 자리)는 16px 을 넉넉히 넘는다 — 검출 크기로는 문제없다', needAmr, () => {
  const v = tagVisibility(calib, amr.labMm, 84, 16);
  assert.ok(v.ok, v.why);
  assert.ok(v.px > 60 && v.px < 120, `${v.px.toFixed(1)}px`);
});

test('먼 자리·뒤쪽은 사유를 준다', needAmr, () => {
  const far = tagVisibility(calib, [0, 0, 0].map((_, i) => calib.labToCam.camPosMm[i] + (i === 2 ? 1000 : 0)), 84);
  assert.equal(far.ok, false);
  const tiny = tagVisibility(calib, amr.labMm, 0.3, 16);
  assert.equal(tiny.ok, false);
  assert.match(tiny.why, /px/);
});

test('시야 피라미드 — 깊이 d 에서 가로폭 ≈ d·W/fx, 귀퉁이 넷이 그 깊이에 찍힌다', () => {
  const d = 1500;
  const f = frustumCamLab(calib, d);
  const w = Math.hypot(...f.corners[1].map((v, i) => v - f.corners[0][i]));
  const want = d * calib.intrinsics.widthPx / calib.intrinsics.fx;
  assert.ok(Math.abs(w - want) < 1, `${w} vs ${want}`);
  for (const c of f.corners) {
    const pr = projectCamLab(calib, c);
    assert.ok(pr && Math.abs(pr.depthMm - d) < 0.01);
  }
});
