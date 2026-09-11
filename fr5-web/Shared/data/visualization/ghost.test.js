import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVisualGhost } from './ghost.js';

const visualGhost = { robotId: 'fr5-lab-a', kind: 'preview', jointsDeg: [1, 2, 3, 4, 5, 6],
  gripperPct: 70, seq: 9, expiresAt: 12 };

test('진행 중 명령 목표가 공동 고스트보다 먼저다', () => {
  const got = selectVisualGhost({ robotId: 'fr5-lab-a', visualGhost,
    motionTarget: { jointsDeg: [6, 5, 4, 3, 2, 1], doneAt: null } }, 10);
  assert.equal(got.source, 'motionTarget');
  assert.deepEqual(got.jointsDeg, [6, 5, 4, 3, 2, 1]);
});

test('공동 고스트는 만료 전만 보인다', () => {
  assert.equal(selectVisualGhost({ visualGhost }, 10).seq, 9);
  assert.equal(selectVisualGhost({ visualGhost }, 12), null);
  assert.equal(selectVisualGhost({ visualGhost: { ...visualGhost, jointsDeg: [0, 1] } }, 10), null);
});
