#!/usr/bin/env bash
# 씬 축 규약 게이트 — `Shared/view3d` 가 `planToScene` 과 어긋나지 않나 (D43).
#
# 축 매핑이 여러 파일에 흩어져 있으면 한쪽만 고쳐졌을 때 **에러 없이 좌우가 뒤집힌다.**
# 배치안만 보면 아무도 못 알아채므로 사람 눈으로는 못 막는다. 숫자로 잰다.
# WebGL 이 필요 없다 — 씬 그래프만 만들어 위치·회전을 대조한다.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
echo "== 씬 축 규약 (planToScene 대조) =="

node --input-type=module -e "
import * as THREE from '$ROOT/node_modules/three/build/three.module.js';
const { createLayoutView } = await import('$ROOT/Shared/view3d/lab/layout-view.js');
const { planToScene } = await import('$ROOT/Shared/data/units/units.js');
// **창·문을 반드시 넣는다.** 없으면 그 코드 경로가 아예 안 돌아 z 범위 검사가 헛돈다 —
// 실제로 창 유리·창틀이 \`Z()\` 를 빼먹고 방 반대편에 떠 있었는데 이 게이트가 통과했다 (2026-08-03).
const L = { id:'T', name:'t', unit:'mm-deg',
  floor:{widthMm:6000, depthMm:4000, heightMm:2700},
  doors:[{wall:'south', atMm:3000, widthMm:1200, heightMm:2100}],
  windows:[{wall:'west', atMm:1200, widthMm:1000, heightMm:1200, sillMm:900},
           {wall:'north', atMm:2500, widthMm:1000, heightMm:1200, sillMm:900}],
  arms:[{id:'fr5', model:'FR5', role:'process', basePosMm:[3000,2000,900], baseYawDeg:30, reachMm:922}],
  stations:[{id:'s1', name:'S1', posMm:[1000,500,0]}],
  amrs:[{id:'a1', model:'tb3', reachMm:300, dockPosMm:[500,3500,0], waypointsMm:[[500,3500],[4000,1000]]}],
  props:[{id:'p1', type:'bench', posMm:[2000,3000,0], rotDeg:45}], verified:false };
const v = createLayoutView(L);
let bad = 0;
const near = (a,b) => Math.abs(a-b) < 1e-9;
const chk = (label, obj, labMm) => {
  const w = planToScene(labMm), g = [obj.position.x, obj.position.y, obj.position.z];
  const ok = g.every((n,i)=>near(n,w[i]));
  if (!ok) bad++;
  console.log((ok?'  ':'  FAIL  ') + label + ' 씬 [' + g.map(n=>n.toFixed(3)) + '] 기대 [' + w.map(n=>n.toFixed(3)) + ']');
};
chk('팔 자리', v.armSlot, [3000,2000,900]);
chk('부품 p1', v.root.getObjectByName('p1'), [2000,3000,0]);
const yaw = (label, got, want) => {
  const ok = near(got, want*Math.PI/180); if (!ok) bad++;
  console.log((ok?'  ':'  FAIL  ') + label + ' rotation.y ' + (got*180/Math.PI).toFixed(1) + '° 기대 ' + want.toFixed(1) + '°');
};
yaw('부품 yaw 45°', v.root.getObjectByName('p1').rotation.y, 45);
yaw('팔 yaw 30°', v.armSlot.rotation.y, 30);
const b = new THREE.Box3().setFromObject(v.root);
const zok = b.min.z < -3.9 && b.max.z < 0.3;   // 깊이 4m 인 방은 z 음수쪽에 선다
if (!zok) bad++;
console.log((zok?'  ':'  FAIL  ') + '방 z 범위 [' + b.min.z.toFixed(2) + ', ' + b.max.z.toFixed(2) + ']');
process.exit(bad ? 1 : 0);
" || exit 1

echo "씬 축 OK"
