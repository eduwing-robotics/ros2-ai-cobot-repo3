import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArmPath } from './contact-check.js';
import { gripperClosingMm, gripperFingerShiftMm } from './gripper-geometry.js';

test('트윈과 접촉 엔진의 PGEA 개폐식은 100→70→4%를 같은 mm로 바꾼다', () => {
  assert.equal(gripperClosingMm(100, 20), 0);
  assert.equal(gripperClosingMm(70, 20), 6);
  assert.equal(gripperClosingMm(4, 20), 19.2);
  assert.equal(gripperFingerShiftMm('finger_left', 70, 20), -6);
  assert.equal(gripperFingerShiftMm('finger_right', 70, 20), 6);
});

test('팔이 멈춘 개폐 칸도 10% 간격의 중간 형상을 전부 검사한다', () => {
  const seen = [];
  const sim = { contactsAt: (_q, gripPct) => { seen.push(gripPct); return { pairs: [] }; } };
  const zero = [0, 0, 0, 0, 0, 0];
  const got = checkArmPath(sim, zero, zero, { fromGripPct: 100, toGripPct: 70 });
  assert.equal(got.samples, 3);
  assert.deepEqual(seen, [90, 80, 70]);
});

test('0~100 밖의 값은 실기 그리퍼와 같은 끝값으로 제한한다', () => {
  assert.equal(gripperClosingMm(120, 20), 0);
  assert.equal(gripperClosingMm(-20, 20), 20);
  assert.equal(gripperClosingMm(null, 20), null);
});
