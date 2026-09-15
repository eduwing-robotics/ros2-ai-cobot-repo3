using System;
using System.Collections.Generic;
using UnityEngine;

// workbench_unity.json 을 읽는 그릇. make_unity_scene.py 가 만든 평탄한 형식이다.
// 원본은 workbench.json 이고 값마다 출처가 달려 있다 — 숫자를 고칠 때는 원본을 고치고
// make_unity_scene.py 를 다시 돌린다.
[Serializable]
public class WorkbenchJson
{
    [Serializable]
    public class Obj
    {
        public string name;
        public string type;         // "box" 또는 "grid_tray"
        public float[] center;      // 로봇 좌표 mm
        public float[] size;        // mm
        public string color;        // "#RRGGBB"
        public float cellPitch;     // grid_tray 만
        public float wall;          // grid_tray 만
    }

    [Serializable] public class GripPt { public float[] xy; }
    [Serializable] public class Place  { public string name; public float[] p; }

    public float tableZ, gripZ, alignZ, matZ;
    public float[] homeTcp;
    public float[] homeJoints;
    public float[] toolRpy;
    public List<Obj> objects = new List<Obj>();
    public List<GripPt> gripPoints = new List<GripPt>();
    public List<Place> places = new List<Place>();

    public static WorkbenchJson Parse(string text)
    {
        var wb = JsonUtility.FromJson<WorkbenchJson>(text);
        if (wb == null || wb.objects == null || wb.objects.Count == 0)
            Debug.LogError("[작업대] JSON 을 못 읽었습니다. make_unity_scene.py 로 만든 "
                         + "workbench_unity.json 인지 확인하세요 (workbench.json 원본은 못 읽습니다).");
        return wb;
    }
}
