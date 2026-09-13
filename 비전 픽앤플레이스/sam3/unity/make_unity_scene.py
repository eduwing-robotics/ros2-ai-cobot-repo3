#!/usr/bin/env python3
"""workbench.json (출처 주석 포함) -> workbench_unity.json (JsonUtility 가 먹는 평탄한 형식).

workbench.json 은 사람이 읽고 고치는 원본이다. 값마다 {"v": ..., "src": "..."} 로
출처를 달아 두었는데 Unity 의 JsonUtility 는 이런 중첩을 못 읽는다.
그래서 값만 뽑아 평탄하게 만든다. 원본을 고치면 이걸 다시 돌린다.

사용법:
    python make_unity_scene.py [출력경로]
    python make_unity_scene.py ~/Imitation_Learning/unity/FR5Viewer/Assets/StreamingAssets/
"""
import json, pathlib, sys

HERE = pathlib.Path(__file__).parent
src = json.loads((HERE / "workbench.json").read_text())

def val(node):
    return node["v"] if isinstance(node, dict) and "v" in node else node

out = {
    "tableZ": val(src["planes"]["table_z"]),
    "gripZ":  val(src["planes"]["grip_z"]),
    "alignZ": val(src["planes"]["align_z"]),
    "matZ":   val(src["planes"]["mat_z"]),
    "homeTcp":    val(src["waypoints"]["home_tcp"]),
    "homeJoints": val(src["waypoints"]["home_joints_deg"]),
    "toolRpy":    val(src["waypoints"]["tool_rpy"]),
    "objects": [],
    "gripPoints": [],
    "places": [],
}

for o in src["objects"]:
    out["objects"].append({
        "name":      o["name"],
        "type":      o["type"],
        "center":    o["center"],
        "size":      o["size"],
        "color":     o["color"],
        "cellPitch": float(o.get("cell_pitch", 0.0)),
        "wall":      float(o.get("wall", 0.0)),
    })

ogp = src["waypoints"]["observed_grip_points"]
for xy in ogp["v"]:
    out["gripPoints"].append({"xy": xy})

for kind in ("tanpi", "tandu"):
    k = src["waypoints"][kind]
    for key in ("place_approach", "place_pose"):
        out["places"].append({"name": f"{kind}_{key}", "p": val(k[key])})

dst = pathlib.Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else HERE
if dst.is_dir():
    dst = dst / "workbench_unity.json"
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(f"{dst}  ({dst.stat().st_size}B)")
print(f"  물체 {len(out['objects'])}개 · 파지점 {len(out['gripPoints'])}개 · 놓기 {len(out['places'])}개")
print(f"  테이블 상판 {out['tableZ']}mm · 파지 평면 {out['gripZ']}mm")
