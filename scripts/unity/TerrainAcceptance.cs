// Run only in an isolated project: -batchmode -executeMethod TerrainAcceptance.Run (without -quit).
using System;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using Orlablocks;
using Orlablocks.Editor;

public static class TerrainAcceptance
{
    static string Root => Environment.GetEnvironmentVariable("ORLA_TERRAIN_FIXTURES");
    static OrlaLevel level;
    static Terrain terrain;
    static float maxError;
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); Debug.Log("TERRAIN_CHECK " + message); }
    static string Folder(string name) => Path.Combine(Root, name);
    static void SyncTo(string name) { level.folder = Folder(name); Sync.Run(level); }
    static OrlaNode Node(string id) => level.GetComponentsInChildren<OrlaNode>(true).FirstOrDefault(n => n.id == id);
    static float Plateau(Terrain t) => t.SampleHeight(new Vector3(5, 0, -3)) + t.transform.position.y;
    static float Sample(Terrain t) => t.terrainData.GetHeights(2, 2, 1, 1)[0, 0];
    static void Sculpt(Terrain t) { t.terrainData.SetHeights(2, 2, new float[,] { { 0.37f } }); }
    static void Finish(int code) { EditorApplication.Exit(code); }
    public static void Run() { EditorApplication.delayCall += Checks; }
    static void Checks()
    {
        try
        {
            Check(!string.IsNullOrEmpty(Root) && Root.StartsWith("/private/tmp/"), "scratch exports only");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var go = new GameObject("Terrain acceptance"); level = go.AddComponent<OrlaLevel>();
            SyncTo("ordinary");
            var source = Node("box_1");
            var addition = new GameObject("Unity addition under input"); addition.transform.SetParent(source.transform); addition.transform.position = new Vector3(1, 2, 3);
            SyncTo("first");
            terrain = go.GetComponentInChildren<Terrain>(); var data = terrain.terrainData; var path = AssetDatabase.GetAssetPath(data);
            Check(addition != null && addition.transform.parent.name.StartsWith("Orphaned ("), "source conversion rescues Unity children");
            Check(addition.transform.position == new Vector3(1, 2, 3), "orphan keeps world transform");
            Check(Node("box_1") == null && Node("cylinder_1") == null && Node("group_1") == null, "source meshes/groups omitted");
            Check(Node("box_3") != null, "ordinary prop preserved");
            Check(data.heightmapResolution == 129 && data.size.x == 32 && data.size.z == 16, "native rectangular TerrainData");
            Check(terrain.transform.position == new Vector3(-6, -5, -15), "negative nonzero terrain origin");
            Check(terrain.GetComponent<TerrainCollider>().terrainData == data, "native collider uses canonical data");
            var m = Manifest.Read(level.folder); var record = m.nodes.First(n => n.type == "terrain");
            var expected = new MeshBinary(level.folder, m.meshes).Heights(record.terrain); var actual = data.GetHeights(0, 0, 129, 129);
            for (int z = 0; z < 129; z++) for (int x = 0; x < 129; x++) maxError = Mathf.Max(maxError, Mathf.Abs(expected[z,x] - actual[z,x]) * data.size.y);
            Check(maxError < 0.002f, "all imported samples within 2mm (actual " + maxError + "m)");
            Physics.SyncTransforms();
            Check(terrain.GetComponent<TerrainCollider>().Raycast(new Ray(new Vector3(5, 30, -3), Vector3.down), out var hit, 100) && Mathf.Abs(hit.point.y - 3) < 0.02f, "collider plateau height");
            var legacyPath = Path.GetDirectoryName(Path.GetDirectoryName(path)) + "/terrain_1.asset";
            if (AssetDatabase.LoadAssetAtPath<TerrainData>(legacyPath) != null) AssetDatabase.DeleteAsset(legacyPath);
            Check(string.IsNullOrEmpty(AssetDatabase.MoveAsset(path, legacyPath)), "simulate 16.1 asset location"); path = legacyPath;
            var terrainNode = Node("terrain_1"); terrainNode.terrainAssetPath = ""; terrainNode.syncedTerrain = "";
            Sync.Run(level); Check(!string.IsNullOrEmpty(terrainNode.syncedTerrain), "legacy unchanged import establishes baseline without rewriting");
            terrainNode.syncedTerrain = ""; Sculpt(terrain); float legacySculpt = Sample(terrain); Sync.Run(level);
            Check(level.terrainChangedInUnity.Contains(terrain.gameObject) && Sample(terrain) == legacySculpt, "legacy sculpt protected before first baseline");
            Nodes.Revert(new[] { terrain.gameObject });
            terrainNode.syncedTerrain = ""; SyncTo("changed");
            Check(level.terrainChangedInUnity.Contains(terrain.gameObject) && Mathf.Abs(Plateau(terrain) - 3) < 0.02f, "legacy changed export requires Revert or Claim once");
            level.folder = Folder("first"); Nodes.Revert(new[] { terrain.gameObject });
            var marker = terrain.gameObject.AddComponent<BoxCollider>(); marker.enabled = false;
            SyncTo("changed");
            Check(terrain.terrainData == data && AssetDatabase.GetAssetPath(data) == path && Mathf.Abs(Plateau(terrain) - 5) < 0.02f, "manual refresh retains object and asset identity");
            Check(marker != null && !marker.enabled, "unrelated terrain component preserved");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo();
            Check(Mathf.Abs(Plateau(terrain) - 3) < 0.02f, "Unity undo restores terrain asset heights");
            Undo.PerformRedo();
            Check(Mathf.Abs(Plateau(terrain) - 5) < 0.02f, "Unity redo restores terrain asset heights");
            EditorUtility.ClearDirty(data); var fingerprint = TerrainSync.Fingerprint(terrain.gameObject);
            SyncTo("unchanged");
            Check(!EditorUtility.IsDirty(data) && fingerprint == TerrainSync.Fingerprint(terrain.gameObject), "unmodified terrain remains untouched on unrelated export");
            var colorTexture = data.terrainLayers[0].diffuseTexture; var oldColor = colorTexture.GetPixel(0, 0);
            SyncTo("color"); var newColor = colorTexture.GetPixel(0, 0);
            Check(newColor != oldColor, "palette refresh updates generated terrain color");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo(); Check(colorTexture.GetPixel(0, 0) == oldColor, "undo restores terrain palette texture");
            Undo.PerformRedo(); Check(colorTexture.GetPixel(0, 0) == newColor, "redo restores terrain palette texture");
            SyncTo("unchanged");
            Sculpt(terrain); float sculpt = Sample(terrain);
            Sync.Run(level);
            Check(level.terrainChangedInUnity.Contains(terrain.gameObject) && Sample(terrain) == sculpt, "sculpt drift detected on unchanged export");
            SyncTo("first");
            Check(level.terrainChangedInUnity.Contains(terrain.gameObject) && Sample(terrain) == sculpt, "sculpt drift protected on changed export");
            Nodes.Revert(new[] { terrain.gameObject });
            Check(!TerrainSync.Drifted(Node("terrain_1")) && Mathf.Abs(Plateau(terrain) - 3) < 0.02f && Sample(terrain) != sculpt, "Revert restores canonical content");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo();
            Check(Sample(terrain) == sculpt, "undo Revert restores sculpted heights"); Undo.PerformRedo();
            Nodes.Claim(new[] { terrain.gameObject }, true); Sculpt(terrain); sculpt = Sample(terrain);
            SyncTo("changed"); Check(Sample(terrain) == sculpt && level.claimedChanged.Contains(terrain.gameObject), "claimed terrain preserved on changed export");
            SyncTo("first"); Check(Sample(terrain) == sculpt, "claimed terrain preserved on unchanged export");
            var second = new GameObject("Second Level").AddComponent<OrlaLevel>(); second.folder = Folder("first"); Sync.Run(second);
            var other = second.GetComponentInChildren<Terrain>();
            Check(other.terrainData != data && other.materialTemplate != terrain.materialTemplate, "Levels have independent generated assets");
            other.terrainData = data; other.GetComponent<TerrainCollider>().terrainData = data;
            Nodes.Revert(new[] { other.gameObject });
            Check(other.terrainData != data && Sample(terrain) == sculpt, "Revert never writes through a claimed shared asset");
            // A claimed terrain may be assigned an unclaimed terrain's owned asset in Unity.
            var ownOtherData = other.terrainData; terrain.terrainData = ownOtherData; terrain.GetComponent<TerrainCollider>().terrainData = ownOtherData;
            Sculpt(terrain); float sharedSculpt = Sample(terrain);
            second.folder = Folder("changed"); Nodes.Revert(new[] { other.gameObject });
            Check(other.terrainData != ownOtherData && Sample(terrain) == sharedSculpt, "claimed reference to target's own asset forces safe fork");
            var fork = other.terrainData; second.folder = Folder("first"); Nodes.Revert(new[] { other.gameObject });
            Check(other.terrainData == fork, "forked terrain asset remains stable on later sync");
            SyncTo("deleted"); Check(terrain != null && level.goneFromOrlablocks.Contains(terrain.gameObject), "deleted claimed terrain retained");
            Nodes.Claim(new[] { terrain.gameObject }, false); Node("terrain_1").syncedTerrain = ""; Sync.Run(level);
            Check(terrain != null && level.terrainChangedInUnity.Contains(terrain.gameObject), "deleted legacy terrain without a baseline protected until decision");
            var child = new GameObject("Unity terrain child"); child.transform.SetParent(terrain.transform);
            Nodes.Revert(new[] { terrain.gameObject });
            Check(terrain == null && child != null && child.transform.parent.name.StartsWith("Orphaned ("), "terrain deletion rescues Unity additions");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo();
            terrain = level.GetComponentInChildren<Terrain>();
            Check(terrain != null && child.transform.parent == terrain.transform, "undo deletion restores terrain and child");
            // Format checks exercise the real C# reader, without touching a Level.
            var bad = new TerrainRecord { offset = record.terrain.offset, resolution = 129, size = new float[] { 32, 0, 16 } };
            bool rejected = false; try { new MeshBinary(Folder("first"), m.meshes).Heights(bad); } catch { rejected = true; }
            Check(rejected, "invalid terrain dimensions rejected");
            string invalid = Folder("invalid"); Directory.CreateDirectory(invalid); var oldVersion = m.version; m.version = 99; File.WriteAllText(Path.Combine(invalid, "level.json"), JsonUtility.ToJson(m));
            rejected = false; try { Manifest.Read(invalid); } catch { rejected = true; } Check(rejected, "future export version rejected");
            m.version = 1; File.WriteAllText(Path.Combine(invalid, "level.json"), JsonUtility.ToJson(m));
            rejected = false; try { Manifest.Read(invalid); } catch { rejected = true; } Check(rejected, "terrain in legacy format rejected"); m.version = oldVersion;
            var legacyManifest = Manifest.Read(Folder("ordinary")); legacyManifest.version = 1;
            File.WriteAllText(Path.Combine(invalid, "level.json"), JsonUtility.ToJson(legacyManifest));
            Check(Manifest.Read(invalid).version == 1, "legacy ordinary exports remain compatible");
            AssetDatabase.SaveAssets();
            EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(), "Assets/TerrainAcceptance.unity");
            EditorSceneManager.OpenScene("Assets/TerrainAcceptance.unity");
            // Find the first Level by its export folder, after the saved references reload.
            level = UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Include).First(l => l.folder == Folder("deleted"));
            SyncTo("first"); terrain = level.GetComponentInChildren<Terrain>();
            Check(!TerrainSync.Drifted(Node("terrain_1")), "saved/reloaded terrain fingerprint is stable");
            terrain.drawTreesAndFoliage = false;
            SyncTo("no-collisions");
            Check(terrain.GetComponent<TerrainCollider>() == null && !terrain.drawTreesAndFoliage, "no-collisions removes collider and preserves unrelated Terrain setting");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo();
            Check(terrain.GetComponent<TerrainCollider>() != null, "undo collider removal restores collider");
            SyncTo("first");
            StartAuto();
        }
        catch (Exception e) { Debug.LogException(e); Finish(1); }
    }
    static double deadline;
    static void CopyExport(string from, string to) { Directory.CreateDirectory(to); foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true); }
    static void StartAuto()
    {
        var watch = Folder("watch"); CopyExport(Folder("first"), watch); level.folder = watch; Sync.Run(level); level.autoSync = true;
        CopyExport(Folder("changed"), watch); File.SetLastWriteTimeUtc(Path.Combine(watch, "level.json"), DateTime.UtcNow.AddSeconds(2));
        deadline = EditorApplication.timeSinceStartup + 15; EditorApplication.update += AutoResult;
    }
    static void AutoResult()
    {
        try
        {
            if (level.exportId != Manifest.Read(Folder("changed")).exportId) { if (EditorApplication.timeSinceStartup > deadline) throw new Exception("Auto sync timed out"); return; }
            EditorApplication.update -= AutoResult;
            Check(Mathf.Abs(Plateau(terrain) - 5) < 0.02f, "real Watcher Auto sync updates same terrain");
            File.WriteAllText(Folder("result.json"), "{\"passed\":true,\"maxHeightErrorMeters\":" + maxError.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
            Debug.Log("TERRAIN_16_4_ACCEPTANCE_PASSED"); Finish(0);
        }
        catch (Exception e) { EditorApplication.update -= AutoResult; Debug.LogException(e); Finish(1); }
    }
}
