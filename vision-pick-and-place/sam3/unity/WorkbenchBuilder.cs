using System.Collections.Generic;
using System.IO;
using UnityEngine;

// workbench.json 을 읽어 작업대를 만든다. 실측값은 로봇 베이스 좌표계 mm 이고,
// 유니티는 왼손 Y-up m 이므로 변환이 필요하다.
//
//   로봇 (X 앞, Y 왼쪽, Z 위, mm)  ->  유니티 (X 오른쪽, Y 위, Z 앞, m)
//   unity = (-Y, Z, X) / 1000
//
// URDF Importer 를 axisType.yAxis 로 불러오면 로봇 모델이 같은 규약을 쓰므로
// 이 변환만 맞추면 작업대와 로봇이 정확히 겹친다.
//
// 쓰는 법: 빈 GameObject 에 붙이고 Play. workbench.json 은 StreamingAssets/ 에 둔다.
public class WorkbenchBuilder : MonoBehaviour
{
    [Tooltip("StreamingAssets 안의 파일 이름")]
    public string jsonName = "workbench_unity.json";

    [Tooltip("경유점·파지점에 작은 표식을 세운다")]
    public bool showWaypoints = true;

    [Tooltip("표식 구의 지름 (m)")]
    public float markerSize = 0.008f;

    // ---- 좌표 변환 ----
    public static Vector3 RobotMmToUnity(float x, float y, float z)
        => new Vector3(-y, z, x) * 0.001f;

    public static Vector3 RobotMmToUnity(IList<float> p)
        => RobotMmToUnity(p[0], p[1], p[2]);

    // 크기는 회전이 아니라 축 교환이므로 부호를 붙이지 않는다
    public static Vector3 SizeMmToUnity(IList<float> s)
        => new Vector3(s[1], s[2], s[0]) * 0.001f;

    void Start()
    {
        string path = Path.Combine(Application.streamingAssetsPath, jsonName);
        if (!File.Exists(path)) { Debug.LogError($"[작업대] 파일 없음: {path}"); return; }

        var wb = WorkbenchJson.Parse(File.ReadAllText(path));
        if (wb == null) return;
        var root = new GameObject("Workbench").transform;
        root.SetParent(transform, false);

        foreach (var o in wb.objects)
        {
            if (o.type == "grid_tray") BuildGridTray(o, root);
            else                       BuildBox(o, root);
        }

        if (showWaypoints) BuildWaypoints(wb, root);

        Debug.Log($"[작업대] {wb.objects.Count}개 생성. 테이블 상판 Z={wb.tableZ}mm, "
                + $"파지 평면 Z={wb.gripZ}mm (로봇 베이스 기준)");
    }

    GameObject BuildBox(WorkbenchJson.Obj o, Transform parent)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = o.name;
        go.transform.SetParent(parent, false);
        go.transform.localPosition = RobotMmToUnity(o.center);
        go.transform.localScale    = SizeMmToUnity(o.size);
        Paint(go, o.color);
        return go;
    }

    // 격자 트레이. 바닥판 + 외벽 4장 + 격자 리브로 만든다.
    // 물체 top 과 리브 top 이 같은 높이라는 것이 실측으로 확인됐으므로(285mm),
    // 리브 높이를 트레이 높이와 같게 둔다 — 깊이 검출이 왜 안 됐는지 씬에서 보인다.
    void BuildGridTray(WorkbenchJson.Obj o, Transform parent)
    {
        var root = new GameObject(o.name).transform;
        root.SetParent(parent, false);
        root.localPosition = RobotMmToUnity(o.center);

        float w = o.size[0], d = o.size[1], h = o.size[2];   // mm
        float t = o.wall, pitch = o.cellPitch;

        void Slab(string n, Vector3 cMm, Vector3 sMm)
        {
            var g = GameObject.CreatePrimitive(PrimitiveType.Cube);
            g.name = n;
            g.transform.SetParent(root, false);
            // 부모가 이미 트레이 중심이라 여기서는 로컬 오프셋만 축 교환한다
            g.transform.localPosition = new Vector3(-cMm.y, cMm.z, cMm.x) * 0.001f;
            g.transform.localScale    = new Vector3(sMm.y, sMm.z, sMm.x) * 0.001f;
            Paint(g, o.color);
        }

        Slab("Floor", new Vector3(0, 0, -h / 2 + t / 2), new Vector3(w, d, t));
        Slab("Wall+X", new Vector3(w / 2 - t / 2, 0, 0), new Vector3(t, d, h));
        Slab("Wall-X", new Vector3(-w / 2 + t / 2, 0, 0), new Vector3(t, d, h));
        Slab("Wall+Y", new Vector3(0, d / 2 - t / 2, 0), new Vector3(w, t, h));
        Slab("Wall-Y", new Vector3(0, -d / 2 + t / 2, 0), new Vector3(w, t, h));

        // 격자 리브. 바깥벽 안쪽을 pitch 간격으로 나눈다
        int nx = Mathf.Max(1, Mathf.RoundToInt((w - 2 * t) / pitch));
        int ny = Mathf.Max(1, Mathf.RoundToInt((d - 2 * t) / pitch));
        float ribH = h - t;                        // 바닥판 위로 올라오는 높이
        float ribZ = t / 2;                        // 바닥판 두께의 절반만큼 올린다
        for (int i = 1; i < nx; i++)
        {
            float x = -w / 2 + t + i * (w - 2 * t) / nx;
            Slab($"RibX{i}", new Vector3(x, 0, ribZ), new Vector3(1.2f, d - 2 * t, ribH));
        }
        for (int j = 1; j < ny; j++)
        {
            float y = -d / 2 + t + j * (d - 2 * t) / ny;
            Slab($"RibY{j}", new Vector3(0, y, ribZ), new Vector3(w - 2 * t, 1.2f, ribH));
        }
        Debug.Log($"[작업대] {o.name}: {nx}x{ny} 칸, 피치 {pitch}mm, 리브 top = 물체 top");
    }

    void BuildWaypoints(WorkbenchJson wb, Transform parent)
    {
        var root = new GameObject("Waypoints").transform;
        root.SetParent(parent, false);

        void Mark(string n, IList<float> pMm, Color c)
        {
            var g = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            g.name = n;
            g.transform.SetParent(root, false);
            g.transform.localPosition = RobotMmToUnity(pMm);
            g.transform.localScale    = Vector3.one * markerSize;
            var m = g.GetComponent<Renderer>().material;
            m.color = c;
            Object.Destroy(g.GetComponent<Collider>());
        }

        Mark("Home", wb.homeTcp, Color.white);

        // 파지점. 정렬 X 가 317 아래였던 것은 빈손으로 끝났다 (7회 중 3/7 성공).
        // 파지 X = 정렬 X + 보정 dx(38.23) 이므로 경계는 355.2 가 된다.
        const float failBoundaryX = 317f + 38.23f;
        for (int i = 0; i < wb.gripPoints.Count; i++)
        {
            var xy = wb.gripPoints[i].xy;
            bool failed = xy[0] < failBoundaryX;
            Mark($"Grip{i}{(failed ? "_fail" : "_ok")}",
                 new List<float> { xy[0], xy[1], wb.gripZ },
                 failed ? new Color(1f, 0.35f, 0.35f) : new Color(0.35f, 1f, 0.45f));
        }
        foreach (var pl in wb.places)
            Mark(pl.name, pl.p, new Color(0.4f, 0.6f, 1f));
    }

    static void Paint(GameObject go, string hex)
    {
        if (!ColorUtility.TryParseHtmlString(hex, out var c)) c = Color.gray;
        var m = go.GetComponent<Renderer>().material;
        m.color = c;
    }
}
