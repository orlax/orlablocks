// Disposable scratch project only. ORLA_WALL_FIXTURES points to wall-attachment-fixtures.ts output.
using System;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using Orlablocks;
using Orlablocks.Editor;
public static class WallAttachmentAcceptance
{
    [Serializable] class Pose { public string id; public float x, y, z, yaw; }
    [Serializable] class Poses { public Pose[] poses; }
    [Serializable] class Failure { public string error; }
    static int checks;
    static string Root => Environment.GetEnvironmentVariable("ORLA_WALL_FIXTURES");
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; Debug.Log("WALL19_CHECK " + message); }
    public static void Run() { EditorApplication.delayCall += Checks; }
    static void Checks()
    {
        try {
            if (string.IsNullOrEmpty(Root) || !Root.StartsWith("/private/tmp/") || !Path.GetFullPath(Application.dataPath).StartsWith("/private/tmp/")) throw new Exception("Scratch project and export required");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var level = new GameObject("Wall19").AddComponent<OrlaLevel>(); level.folder = Root; Sync.Run(level);
            var poses = JsonUtility.FromJson<Poses>(File.ReadAllText(Path.Combine(Root,"poses.json"))).poses;
            Check(poses.Length == 9,"nine frames imported");
            foreach (var pose in poses) {
                var node = level.GetComponentsInChildren<OrlaNode>(true).First(n => n.id == pose.id);
                Check(Vector3.Distance(node.transform.position,new Vector3(pose.x,pose.y,pose.z)) < .001f,"resolved world position " + pose.id);
                var expected = Quaternion.Euler(0,pose.yaw,0) * Vector3.right;
                Check(Vector3.Distance(node.transform.right, expected) < .001f,"local +x facing " + pose.id);
                var collider = node.GetComponentInChildren<Collider>(); Check(collider != null,"frame collider " + pose.id);
                Physics.SyncTransforms();
                var center = node.transform.TransformPoint(new Vector3(0,.5f,0));
                Check(collider.Raycast(new Ray(center + node.transform.right, -node.transform.right),out var hit,2),"collider follows mounted face " + pose.id);
                Check(Vector3.Dot(hit.normal,node.transform.right) > .99f,"mounted face normal " + pose.id);
            }
            EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(),"Assets/Wall19.unity");
            EditorSceneManager.OpenScene("Assets/Wall19.unity");
            level = UnityEngine.Object.FindFirstObjectByType<OrlaLevel>(); Sync.Run(level);
            foreach (var pose in poses) {
                var node = level.GetComponentsInChildren<OrlaNode>(true).First(n => n.id == pose.id);
                Check(Vector3.Distance(node.transform.position,new Vector3(pose.x,pose.y,pose.z)) < .001f,"save/reopen/resync mount " + pose.id);
            }
            File.WriteAllText(Path.Combine(Root,"unity-result.json"),"{\"ok\":true,\"checks\":"+checks+"}"); EditorApplication.Exit(0);
        } catch(Exception e) { Debug.LogException(e); if(!string.IsNullOrEmpty(Root)) File.WriteAllText(Path.Combine(Root,"unity-result.json"),JsonUtility.ToJson(new Failure { error=e.ToString() })); EditorApplication.Exit(1); }
    }
}
