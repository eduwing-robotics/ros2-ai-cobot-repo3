# ROBOTIS Burger STL 4장 → 우리 규약에 맞춘 GLB 한 장.
#
# 왜 조립을 여기서 하나 — URDF 가 부품을 관절 원점으로 흩어 놓는다. 런타임에 4장을 받아
# 자리를 잡으면 자리 계산이 화면에 들어온다. **구울 때 한 번 하면 끝난다.**
#
# 우리 규약 (`parts.js` 머리) — 원점은 **바닥 중앙**, 정면은 **+Z**, 단위는 미터(glTF).
# ROS 는 Z-up · X-forward 라 축을 돌려 굽는다.
#
# ⭐ **2026-09-06 — 한 덩어리가 아니라 노드 4개다** (`docs/archive/GRILL-conveyor-twin-progresslog-2026-09-06.md` #8).
#   전엔 `join()` 으로 합쳐 드로우콜 1개였는데, 그러면 **바퀴가 돌 수 없다** — 회전시킬 대상이 없다.
#   지금은 루트(Empty) 아래 `base` · `wheel_left` · `wheel_right` · `lds` 넷이고, 축 정렬·바닥 원점은
#   **루트의 노드 변환**으로 든다(자식 로컬 프레임 = ROS 프레임 · 바퀴 축 = 로컬 +Y).
#   드로우콜 1 → 4 는 방 12m 장면에서 잴 수 없는 차이다. 바퀴 회전은 `Shared/view3d/burger.js` `rollWheels`.
import bpy, sys, math, os
from mathutils import Vector

if bpy.app.version < (4, 0, 0):   # `wm.stl_import` 는 4.x 부터 — 3.x 에서는 AttributeError 로 즉사한다 (감사 2026-09-06 ④-8)
    sys.exit(f'Blender 4.x 가 필요하다 — 지금 {bpy.app.version_string}')
SRC = sys.argv[sys.argv.index('--') + 1]
OUT = sys.argv[sys.argv.index('--') + 2]
TARGET_TRIS = int(sys.argv[sys.argv.index('--') + 3])

# ── URDF 에서 읽은 배치 (base_footprint = 바닥 기준 · ROS 축)
#   base_link 는 바닥에서 +0.010, 그 안에서 visual 이 x -0.032 만큼 밀려 있다.
#   바퀴 관절 원점은 (0, ±0.08, 0.023)+0.010 — 바퀴 **축 중심**이다 (URDF wheel_*_joint · axis 0 0 1 · rpy −1.57 ↔ visual rpy 1.57 이 상쇄).
PARTS = [
    ('base',        'burger_base.stl', (-0.032, 0.0,  0.010), False),
    ('wheel_left',  'left_tire.stl',   ( 0.0,   0.08, 0.033), True),
    ('wheel_right', 'right_tire.stl',  ( 0.0,  -0.08, 0.033), True),
    ('lds',         'lds.stl',         (-0.032, 0.0,  0.182), False),
]

bpy.ops.wm.read_factory_settings(use_empty=True)

objs = []
for name, fname, xyz, is_wheel in PARTS:
    path = os.path.join(SRC, fname)
    bpy.ops.wm.stl_import(filepath=path)
    o = bpy.context.selected_objects[0]
    o.name = name
    # **STL 은 밀리미터, URDF 원점은 미터다.** 이걸 안 맞추면 바퀴가 0.08mm 만 벌어져
    # 몸통에 파묻히고 폭이 30mm 부족해진다 (첫 판이 그랬다 — 147.8 대신 178 이어야 한다).
    o.scale = (0.001, 0.001, 0.001)
    bpy.ops.object.transform_apply(scale=True)
    if is_wheel:
        # **원점을 축 중심에 둔다** — 회전은 원점을 도니까. STL 원점이 기하 중심과 얼마나 다른지 적는다
        bb = [Vector(c) for c in o.bound_box]
        ctr = sum(bb, Vector()) / 8
        print(f'  {name}: STL 원점 ↔ 기하 중심 차 mm ({ctr.x*1000:.1f}, {ctr.y*1000:.1f}, {ctr.z*1000:.1f})')
        # 축 중심 = 바운딩 박스 중심이라는 가정을 **검사한다** — 어긋나면 바퀴가 축 밖을 돈다. print 만 하면 아무도 안 읽는다 (감사 ④-7)
        assert ctr.length * 1000 < 0.5, f'{name}: 기하 중심이 STL 원점에서 {ctr.length*1000:.1f}mm — 축 중심 가정이 깨졌다'
        bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
    o.location = Vector(xyz)
    objs.append(o)
    print(f'  들임 {fname:18} 삼각 {len(o.data.polygons):>7,}')

raw = sum(len(o.data.polygons) for o in objs)
print(f'  합계 삼각 {raw:,}')

# **꼭짓점을 안 붙인다.** 붙여 보니 감량기가 실루엣을 더 깎았다 (높이 191 → 186mm).
# ── 감량 — 부품마다 같은 비율. 방 12m 안에서 180mm 짜리라 화면에서 수십 px 다
if raw > TARGET_TRIS:
    ratio = TARGET_TRIS / raw
    for o in objs:
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        d = o.modifiers.new('dec', 'DECIMATE')
        d.ratio = ratio
        bpy.ops.object.modifier_apply(modifier='dec')
print(f'  감량 삼각 {sum(len(o.data.polygons) for o in objs):,}')

# ── 루트 아래 묶는다. 축·원점은 **루트 변환**으로 — 자식 로컬은 ROS 프레임 그대로(바퀴 축 = +Y)
root = bpy.data.objects.new('turtlebot3_burger', None)
bpy.context.scene.collection.objects.link(root)
for o in objs:
    o.parent = root
    o.data.materials.clear()      # **재질을 굽지 않는다** — 화면이 `mat.amr` 로 덮는다 (D62)

# ROS +X(정면) → glTF +Z 가 되게 Z 축 −90°
root.rotation_euler = (0.0, 0.0, math.radians(-90))
bpy.context.view_layer.update()

def world_bbox():
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    mn = Vector((min(v.x for v in pts), min(v.y for v in pts), min(v.z for v in pts)))
    mx = Vector((max(v.x for v in pts), max(v.y for v in pts), max(v.z for v in pts)))
    return mn, mx

# 바닥 중앙에 앉힌다 — 좌우·앞뒤는 가운데, 아래는 z=0 (Blender Z-up · 내보내기가 +Z→+Y)
mn, mx = world_bbox()
root.location = Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))
bpy.context.view_layer.update()
mn, mx = world_bbox()
print('  BLENDER bbox mm  x %.0f  y %.0f  z %.0f' % ((mx.x-mn.x)*1000, (mx.y-mn.y)*1000, (mx.z-mn.z)*1000))
print('  → GLTF  기대치   폭(x) %.0f  높이(y) %.0f  깊이(z) %.0f'
      % ((mx.x-mn.x)*1000, (mx.z-mn.z)*1000, (mx.y-mn.y)*1000))
print('  바닥 접지 mm %.1f' % (mn.z * 1000))
for o in objs:
    if o.name.startswith('wheel'):
        w = o.matrix_world.translation
        print('  %s 축 중심(월드 mm) x %.1f y %.1f z %.1f' % (o.name, w.x*1000, w.y*1000, w.z*1000))

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    use_selection=False,
    export_yup=True,
    export_apply=True,
    export_materials='NONE',        # 재질·텍스처를 안 싣는다
    export_normals=True,
    export_texcoords=False,
    # **Draco 를 안 쓴다.** 144KB 로 줄지만 DRACOLoader + WASM 디코더(~200KB)를 또 받아야 해서
    # 합계로는 손해다. 압축 없이 두면 서버 gzip 이 전송량을 반으로 줄이고 의존성이 0 이다.
    export_draco_mesh_compression_enable=False,
)
print('  나옴 %s  %.0f KB' % (OUT, os.path.getsize(OUT) / 1024))
