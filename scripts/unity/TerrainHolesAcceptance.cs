// Run in a disposable /private/tmp project with ORLA_TERRAIN_HOLES_FIXTURES set.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using Orlablocks;
using Orlablocks.Editor;

public static class TerrainHolesAcceptance
{
    static string Root => Environment.GetEnvironmentVariable("ORLA_TERRAIN_HOLES_FIXTURES");
    static int checks;
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; Debug.Log("TERRAIN20_CHECK " + message); }
    static string Folder(string name) => Path.Combine(Root, name);
    static OrlaLevel level;
    static Terrain Terrain => level.GetComponentInChildren<Terrain>();
    static OrlaNode Node => Terrain.GetComponent<OrlaNode>();
    static void To(string name) { level.folder = Folder(name); Sync.Run(level); }
    static bool Equal(bool[,] a, bool[,] b) => a.GetLength(0) == b.GetLength(0) && a.Cast<bool>().SequenceEqual(b.Cast<bool>());
    static bool[,] Mask => Terrain.terrainData.GetHoles(0, 0, 128, 128);
    static bool Ray(float x, float z) { Physics.SyncTransforms(); return Terrain.GetComponent<TerrainCollider>().Raycast(new Ray(new Vector3(x, 30, z), Vector3.down), out _, 100); }
    static string OldBaseline() => (string)typeof(TerrainSync).GetMethod("Fingerprint", BindingFlags.Static | BindingFlags.NonPublic, null, new[] { typeof(GameObject), typeof(bool) }, null).Invoke(null, new object[] { Terrain.gameObject, true });
    public static void Run() { EditorApplication.delayCall += Checks; }
    static void Checks()
    {
        try
        {
            if (string.IsNullOrEmpty(Root) || !Root.StartsWith("/private/tmp/") || !Path.GetFullPath(Application.dataPath).StartsWith("/private/tmp/")) throw new Exception("Scratch project and fixtures required");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            level = new GameObject("Terrain20").AddComponent<OrlaLevel>(); To("none");
            var data = Terrain.terrainData; var path = AssetDatabase.GetAssetPath(data);
            var fallback = data.terrainLayers[0];
            Check(fallback.smoothness == 0 && fallback.metallic == 0 && fallback.smoothnessSource == TerrainLayerSmoothnessSource.ConstantOnly, "generated layer explicitly matte");
            var mappings = ScriptableObject.CreateInstance<OrlaMappings>(); AssetDatabase.CreateAsset(mappings, "Assets/Terrain20Mappings.asset");
            var layer = new TerrainLayer { tileSize = new Vector2(13, 7), smoothness = .3f, metallic = .2f };
            AssetDatabase.CreateAsset(layer, "Assets/Terrain20Grass.terrainlayer");
            var rule = new OrlaMappings.ColorMapping { color = "green", terrainLayer = layer }; mappings.colors.Add(rule); level.mappings = mappings;
            var originalLayer = EditorJsonUtility.ToJson(layer); EditorUtility.ClearDirty(layer);
            To("none");
            Check(data.terrainLayers[0] == layer && EditorJsonUtility.ToJson(layer) == originalLayer && !EditorUtility.IsDirty(layer), "terrain-only mapping applies without modifying external layer");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo(); Check(data.terrainLayers[0] == fallback, "mapping Sync undo restores fallback reference");
            Undo.PerformRedo(); Check(data.terrainLayers[0] == layer, "mapping Sync redo restores external reference");
            layer.tileSize = new Vector2(9, 6); layer.smoothness = .1f; Sync.Run(level);
            Check(!TerrainSync.Drifted(Node) && level.terrainChangedInUnity.Length == 0, "external layer edits do not cause terrain drift");
            Check(string.IsNullOrEmpty(AssetDatabase.MoveAsset(AssetDatabase.GetAssetPath(layer), "Assets/Terrain20GrassRenamed-" + Guid.NewGuid().ToString("N") + ".terrainlayer")), "external layer can be renamed");
            Sync.Run(level); Check(!TerrainSync.Drifted(Node), "external layer rename preserves its managed reference identity");
            var second = new GameObject("Second").AddComponent<OrlaLevel>(); second.folder = Folder("none"); second.mappings = mappings; Sync.Run(second);
            var other = second.GetComponentInChildren<Terrain>(); other.GetComponent<OrlaNode>().claimed = true;
            rule.terrainLayer = null; Sync.Run(level);
            Check(data.terrainLayers[0] == fallback && Terrain.terrainData == data && AssetDatabase.GetAssetPath(data) == path && other.terrainData.terrainLayers[0] == layer, "clearing mapping retains data identity and leaves claimed shared layer alone");
            rule.terrainLayer = layer; Sync.Run(level);
            var replacement = new TerrainLayer(); AssetDatabase.CreateAsset(replacement, "Assets/Terrain20Dirt.terrainlayer");
            rule.terrainLayer = replacement; Sync.Run(level); Check(data.terrainLayers[0] == replacement, "changing layer mapping refreshes unchanged export");
            data.terrainLayers = new[] { layer }; Sync.Run(level); Check(level.terrainChangedInUnity.Contains(Terrain.gameObject), "manual layer reference changes are protected");
            Nodes.Revert(new[] { Terrain.gameObject });
            Node.syncedTerrain = OldBaseline(); Sync.Run(level); Check(Node.syncedTerrain.StartsWith("v2:") && !TerrainSync.Drifted(Node), "old baseline migrates after legacy comparison");
            Node.syncedTerrain = OldBaseline(); data.SetHeights(2,2,new float[,] { { .4f } }); Sync.Run(level);
            Check(level.terrainChangedInUnity.Contains(Terrain.gameObject), "old baseline verifies sculpt before migration");
            Nodes.Revert(new[] { Terrain.gameObject });
            Node.syncedTerrain = OldBaseline(); data.SetHoles(2, 2, new bool[,] { { false } }); Sync.Run(level);
            Check(level.terrainChangedInUnity.Contains(Terrain.gameObject) && !data.GetHoles(2,2,1,1)[0,0], "painted holes protected during baseline migration");
            Nodes.Revert(new[] { Terrain.gameObject });
            To("holes"); var authored = Mask;
            var m = Manifest.Read(level.folder); var r = m.nodes.First(n => n.type == "terrain"); var bin = new MeshBinary(level.folder, m.meshes);
            Check(Equal(authored, bin.Holes(r.terrain)), "all imported mask cells match reversed export");
            Check(!Ray(5, -3) && !Ray(20, -10) && Ray(8.5f, -3), "TerrainCollider misses both asymmetric holes and hits adjacent plateau");
            Check(Terrain.terrainData == data && !TerrainSync.Drifted(Node), "hole refresh retains stable asset and baseline");
            To("moved"); Check(!Equal(Mask, authored), "hole-only source edit refreshes mask");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo(); Check(Equal(Mask, authored), "Undo restores terrain hole mask");
            Undo.PerformRedo(); Check(!Equal(Mask, authored), "Redo restores changed hole mask");
            To("none"); Check(Mask.Cast<bool>().All(v => v) && Ray(5, -3), "removing last holes restores surface and collision");
            data.SetHoles(2,2,new bool[,] { { false } }); Sync.Run(level);
            Check(level.terrainChangedInUnity.Contains(Terrain.gameObject), "local painted holes drift on unchanged export");
            To("holes"); Check(!data.GetHoles(2,2,1,1)[0,0], "changed export preserves local painted holes");
            Nodes.Revert(new[] { Terrain.gameObject }); Check(Equal(Mask, authored), "Revert restores authored mask");
            Nodes.Claim(new[] { Terrain.gameObject }, true); To("none"); Check(Equal(Mask, authored), "claimed mask preserved");
            Nodes.Claim(new[] { Terrain.gameObject }, false); Nodes.Revert(new[] { Terrain.gameObject });
            To("all"); Check(Mask.Cast<bool>().All(v => !v) && !Ray(5,-3), "all-hole terrain imports and has no surface collision");
            To("holes"); EditorUtility.SetDirty(mappings); AssetDatabase.SaveAssets(); EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(), "Assets/Terrain20.unity");
            EditorSceneManager.OpenScene("Assets/Terrain20.unity"); level = UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Include).First(l => l.folder == Folder("holes"));
            Sync.Run(level); Check(Equal(Mask, authored) && !TerrainSync.Drifted(Node), "mask and external layer baseline survive save/reload");
            Check(level.mappings.colors[0].terrainLayer == Terrain.terrainData.terrainLayers[0], "terrain-only mapping asset persists");
            // A partial Sync must roll back a mask already applied before a later invalid terrain record.
            var broken = Folder("broken"); Directory.CreateDirectory(broken);
            foreach (var file in Directory.GetFiles(Folder("none"))) File.Copy(file, Path.Combine(broken,Path.GetFileName(file)), true);
            var badManifest = Manifest.Read(broken); var goodRecord = badManifest.nodes.First(n => n.type == "terrain"); goodRecord.rev = "force-mask-refresh";
            var badRecord = JsonUtility.FromJson<NodeRecord>(JsonUtility.ToJson(goodRecord)); badRecord.id = "terrain_bad";
            badRecord.terrain.holes.offset = int.MaxValue; badManifest.nodes = badManifest.nodes.Concat(new[] { badRecord }).ToArray();
            File.WriteAllText(Path.Combine(broken,"level.json"), JsonUtility.ToJson(badManifest));
            var checkpoint = level.exportId; level.folder = broken; bool failed = false; try { Sync.Run(level); } catch { failed = true; }
            Check(failed && Equal(Mask, authored) && level.exportId == checkpoint && !TerrainSync.Drifted(Node), "failed Sync rolls back earlier mask and checkpoint changes");
            level.folder = Folder("holes");
            // An unassigned generated fallback can still be referenced by a claimed terrain.
            var fallbackPath = AssetDatabase.GetAssetPath(Terrain.terrainData);
            var ownFallback = AssetDatabase.LoadAssetAtPath<TerrainLayer>(fallbackPath.Substring(0,fallbackPath.Length-6) + "-layer.terrainlayer");
            other = UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Include).First(l => l != level).GetComponentInChildren<Terrain>();
            other.terrainData.terrainLayers = new[] { ownFallback }; other.GetComponent<OrlaNode>().claimed = true;
            var protectedColor = ownFallback.diffuseTexture.GetPixel(0,0); var oldData = Terrain.terrainData;
            level.mappings.colors[0].terrainLayer = null; Sync.Run(level);
            Check(Terrain.terrainData != oldData && ownFallback.diffuseTexture.GetPixel(0,0) == protectedColor && other.terrainData.terrainLayers[0] == ownFallback, "inactive fallback used by a claim is forked before writing");
            // Legacy format 2 with no mask reads as full surface; version 3 requires a mask.
            m.version = 2; r.terrain.holes = null;
            // JsonUtility serializes a null inline class as an empty record. Old TS exports omit this field.
            var legacyJson = System.Text.RegularExpressions.Regex.Replace(JsonUtility.ToJson(m), ",?\"holes\":\\{[^}]*\\}", "");
            var legacy = Folder("legacy"); Directory.CreateDirectory(legacy); File.WriteAllText(Path.Combine(legacy,"level.json"), legacyJson);
            Check(Manifest.Read(legacy).version == 2 && bin.Holes(r.terrain).Cast<bool>().All(v => v), "legacy version 2 without mask reads as full surface");
            File.WriteAllText(Path.Combine(legacy,"level.json"), legacyJson.Replace("\"version\":2", "\"version\":3"));
            bool rejected = false; try { Manifest.Read(legacy); } catch { rejected = true; } Check(rejected, "version 3 missing mask rejected");
            r.terrain.holes = new TerrainHoles { offset = int.MaxValue, resolution = 128 };
            rejected = false; try { bin.Holes(r.terrain); } catch { rejected = true; } Check(rejected, "malformed hole range rejected");
            File.WriteAllText(Path.Combine(Root,"terrain20-result.json"), "{\"passed\":" + checks + "}");
            EditorApplication.Exit(0);
        }
        catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
}
