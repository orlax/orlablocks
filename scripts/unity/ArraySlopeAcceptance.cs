// Run in disposable /private/tmp project only, ORLA_ARRAY_FIXTURES points at exported fixture.
using System;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using Orlablocks;
using Orlablocks.Editor;
public static class ArraySlopeAcceptance
{
    static int checks;
    static string Root => Environment.GetEnvironmentVariable("ORLA_ARRAY_FIXTURES");
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; Debug.Log("ARRAY19_CHECK " + message); }
    public static void Run() { EditorApplication.delayCall += Checks; }
    static void Checks()
    {
        try {
            if (string.IsNullOrEmpty(Root) || !Root.StartsWith("/private/tmp/") || !Path.GetFullPath(Application.dataPath).StartsWith("/private/tmp/")) throw new Exception("Scratch project and export required");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var level = new GameObject("Array19").AddComponent<OrlaLevel>(); level.folder = Root; Sync.Run(level);
            var nodes = level.GetComponentsInChildren<OrlaNode>(true);
            Func<string, OrlaNode> node = id => nodes.First(n => n.id == id);
            var up = node("array_1/0"); var down = node("array_2/0"); var legacy = node("array_3/0"); var vertical = node("array_4/0");
            Check(Vector3.Distance(up.transform.right, new Vector3(.8f,.6f,0)) < .001f, "uphill local +x follows 3D tangent");
            Check(Vector3.Distance(down.transform.right,new Vector3(.8f,-.6f,0)) < .001f, "downhill tangent");
            Check(Vector3.Distance(legacy.transform.right,Vector3.right) < .001f, "legacy array stays upright");
            Check(Vector3.Distance(vertical.transform.right,Vector3.up) < .001f, "vertical tangent fallback");
            Check(!nodes.Any(n => n.id == "array_5/1") && nodes.Count(n => n.id.StartsWith("array_5/")) == 5, "circle spacing count and skip");
            foreach (var item in nodes.Where(n => n.id.Contains("/"))) {
                var collider = item.GetComponentInChildren<Collider>(); Check(collider != null && (!(collider is MeshCollider) || ((MeshCollider)collider).sharedMesh != null), "item has collider " + item.id);
                Physics.SyncTransforms();
                var center = item.transform.TransformPoint(new Vector3(0,.1f,0));
                Check(collider.Raycast(new Ray(center + item.transform.up * 3, -item.transform.up),out var hit,10), "collider follows oriented geometry " + item.id);
                Check(Math.Abs(Vector3.Dot(hit.normal,item.transform.up)) > .99f,"collider face normal follows item orientation " + item.id);
            }
            EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(),"Assets/Array19.unity");
            EditorSceneManager.OpenScene("Assets/Array19.unity");
            level = UnityEngine.Object.FindFirstObjectByType<OrlaLevel>(); Sync.Run(level);
            Check(Vector3.Distance(level.GetComponentsInChildren<OrlaNode>().First(n=>n.id=="array_1/0").transform.right,new Vector3(.8f,.6f,0)) < .001f,"save/reopen sync retains slope");
            File.WriteAllText(Path.Combine(Root,"unity-result.json"),"{\"ok\":true,\"checks\":"+checks+"}"); EditorApplication.Exit(0);
        } catch(Exception e) { Debug.LogException(e); if(!string.IsNullOrEmpty(Root)) File.WriteAllText(Path.Combine(Root,"unity-result.json"),JsonUtility.ToJson(new Failure { error=e.ToString() })); EditorApplication.Exit(1); }
    }
    [Serializable] class Failure { public string error; }
}
