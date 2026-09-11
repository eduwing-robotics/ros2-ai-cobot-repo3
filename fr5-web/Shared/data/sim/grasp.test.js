import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carrierOffsetAtInset, graspFromCenter, bulletsNearGraspWall, GRASP_INSET_CANDIDATES_MM } from './grasp.js';
import { PREGRIP_OPEN_MM } from './load-steps.js';

test('긴 벽 중앙 파지점은 중심에서 반폭 34.5mm이고 두 벽은 서로 반대다', () => {
  assert.deepEqual(graspFromCenter([0, 0], 0, false), [-34.5, 0]);
  assert.deepEqual(graspFromCenter([0, 0], 0, true), [34.5, 0]);
});

test('물림 깊이는 긴 변 중앙을 옆으로 밀지 않고 벽 법선 안쪽으로만 움직인다', () => {
  assert.deepEqual(GRASP_INSET_CANDIDATES_MM, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(graspFromCenter([0, 0], 0, false, 10), [-24.5, 0]);
  assert.deepEqual(graspFromCenter([0, 0], 0, true, 10), [24.5, 0]);
  assert.deepEqual(carrierOffsetAtInset(0, false, 10), { dxMm: 24.5, dyMm: 0 });
});

test('28mm 사전 성형은 중앙 총알과 겹치는 벽만 막고 반대 벽은 남긴다', () => {
  const center = [0, 0]; const bullet = [[4, 0]];
  assert.equal(bulletsNearGraspWall(center, bullet, 0, false, 40).length, 1);
  assert.equal(PREGRIP_OPEN_MM, 28);
  assert.equal(bulletsNearGraspWall(center, bullet, 0, false).length, 0);
  assert.equal(bulletsNearGraspWall(center, bullet, 0, true).length, 1);
});

test('09-10 실측 총알은 선택한 반대 긴 벽의 28mm 하강 띠 밖이다', () => {
  const center = [-188.28, -1033.69]; const bullet = [[-178.7, -1035.6]];
  assert.equal(bulletsNearGraspWall(center, bullet, -179.001, true).length, 0);
});

test('벽 가까운 총알은 그 벽만 막고 반대 긴 벽은 남긴다', () => {
  const center = [0, 0]; const bulletNearFalseWall = [[-29.5, 0]];
  assert.equal(bulletsNearGraspWall(center, bulletNearFalseWall, 0, false).length, 1);
  assert.equal(bulletsNearGraspWall(center, bulletNearFalseWall, 0, true).length, 0);
});
