import os

import mujoco
import numpy as np

# ⚠ 예전에는 `share/urdf/` 사본을 봤는데 그건 08-12 판이라 탄두·그리퍼가 없었다.
#   현행 씬은 이 파일 옆에 있다 (2026-09-03).
MJCF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fairino5_v6_mjmodel.xml")
model = mujoco.MjModel.from_xml_path(MJCF)

def quat_to_R(q):
    R = np.zeros(9)
    mujoco.mju_quat2Mat(R, q)
    return R.reshape(3, 3)

for i in range(model.ngeom):
    if model.geom_type[i] != mujoco.mjtGeom.mjGEOM_MESH:
        continue
    mesh_id = model.geom_dataid[i]
    if mesh_id < 0:
        continue

    vert_adr = model.mesh_vertadr[mesh_id]
    vert_num = model.mesh_vertnum[mesh_id]
    verts = model.mesh_vert[vert_adr:vert_adr + vert_num].reshape(-1, 3).copy()

    # 1단계: mesh 자체의 컴파일러 보정 (CoM/주축 재정렬)
    R_mesh = quat_to_R(model.mesh_quat[mesh_id].copy())
    mesh_pos = model.mesh_pos[mesh_id].copy()
    verts_geomframe = verts @ R_mesh.T + mesh_pos

    # 2단계: 이 geom 자체에 걸린 pos/quat 오프셋 (예: 그리퍼처럼 별도 장착 위치가 있는 경우)
    R_geom = quat_to_R(model.geom_quat[i].copy())
    geom_pos = model.geom_pos[i].copy()
    verts_body = verts_geomframe @ R_geom.T + geom_pos

    body_id = model.geom_bodyid[i]
    body_name = model.body(body_id).name
    mesh_name = model.mesh(mesh_id).name

    centroid = verts_body.mean(axis=0)
    centered = verts_body - centroid
    cov = centered.T @ centered
    eigvals, eigvecs = np.linalg.eigh(cov)
    principal_axis = eigvecs[:, -1]

    proj = centered @ principal_axis
    p1 = centroid + principal_axis * proj.min()
    p2 = centroid + principal_axis * proj.max()

    lo, hi = np.percentile(proj, [20, 80])
    mask = (proj >= lo) & (proj <= hi)
    perp = centered - np.outer(proj, principal_axis)
    perp_dist = np.linalg.norm(perp, axis=1)
    radius = np.percentile(perp_dist[mask], 75) if mask.sum() > 0 else np.percentile(perp_dist, 50)

    print(f"body={body_name}, mesh={mesh_name}")
    print(f'  fromto="{p1[0]:.4f} {p1[1]:.4f} {p1[2]:.4f}  {p2[0]:.4f} {p2[1]:.4f} {p2[2]:.4f}"')
    print(f'  size="{radius:.4f}"')
    print()