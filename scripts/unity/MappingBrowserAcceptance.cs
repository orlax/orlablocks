using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Orlablocks;
using Orlablocks.Editor;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

// Copy under Assets/Editor in a scratch Unity project. Never run in a game project.
public static class MappingBrowserAcceptance
{
    static int checks;
    static string Root => Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
    static void ScratchOnly() { if (!Path.GetFullPath(Application.dataPath).StartsWith("/private/tmp/orla-mappings-18-browser/")) throw new Exception("Requires /private/tmp/orla-mappings-18-browser"); }
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; Debug.Log("BROWSER_CHECK " + message); }
    static void Set(object target, string name, object value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(target, value);
    static void Call(object target, string name, params object[] args) => target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(target, args);
    public static void Run() { EditorApplication.delayCall += Checks; }
    static void Checks()
    {
        try
        {
            ScratchOnly();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            AssetDatabase.DeleteAsset("Assets/BrowserFixture"); AssetDatabase.DeleteAsset(Assets.ProjectRoot("browser_fixture"));
            Directory.CreateDirectory("Assets/BrowserFixture"); AssetDatabase.Refresh();
            var prefabRoot = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            var prefab = PrefabUtility.SaveAsPrefabAsset(prefabRoot, "Assets/BrowserFixture/Guard.prefab");
            UnityEngine.Object.DestroyImmediate(prefabRoot);
            var mat = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(mat, "Assets/BrowserFixture/Blue.mat");
            var m = ScriptableObject.CreateInstance<OrlaMappings>(); AssetDatabase.CreateAsset(m, "Assets/BrowserFixture/Mappings.asset");
            m.entities.Add(new OrlaMappings.EntityMapping { entity = "npc_002", prefab = prefab, scale = 1.2f, offset = new Vector3(1,2,3), rotation = new Vector3(0,45,0), blockout = OrlaMappings.Blockout.KeepHidden });
            m.entities.Add(new OrlaMappings.EntityMapping { entity = "unknown_manual", prefab = prefab });
            m.entities.Add(new OrlaMappings.EntityMapping { entity = "npc_003", prefab = prefab });
            m.entities.Add(new OrlaMappings.EntityMapping { entity = "npc_003", prefab = prefab, scale = 2 });
            m.entities.Add(new OrlaMappings.EntityMapping { entity = "npc_004" });
            m.tags.Add(new OrlaMappings.TagMapping { tag = "npc", setLayer = true, layer = 8, unityTag = "MissingGameTag", staticFlags = 4, keepInBuilds = true, components = new System.Collections.Generic.List<string> { typeof(AudioSource).AssemblyQualifiedName, "Missing.Component, MissingAssembly" } });
            m.colors.Add(new OrlaMappings.ColorMapping { color = "blue", body = mat, floor = mat });
            EditorUtility.SetDirty(m); AssetDatabase.SaveAssets();
            var export = new Manifest { format = Manifest.Format, version = 2, project = new ProjectInfo { id = "browser_fixture" }, scene = new SceneInfo { id = "catalog", name = "Catalog" },
                entities = Enumerable.Range(0,120).Select(i => new EntityRecord { id = "npc_" + i.ToString("000"), name = "NPC " + i.ToString("000") }).ToArray(),
                tags = new[] { new LibraryEntry { name = "npc" }, new LibraryEntry { name = "unmapped_tag" } }, palette = new[] { new PaletteEntry { key = "blue", color = "#2080ff" } } };
            var folder = Path.Combine(Root, "ExportFixture"); Directory.CreateDirectory(folder); File.WriteAllText(Path.Combine(folder, "level.json"), JsonUtility.ToJson(export));
            var level = new GameObject("Catalog Level").AddComponent<OrlaLevel>(); level.mappings = m; level.folder = folder; level.exportId = 17;
            var unreadable = new GameObject("Unreadable Level").AddComponent<OrlaLevel>(); unreadable.mappings = m; unreadable.folder = folder + "-missing";
            var sourcePath = Assets.ProjectRoot("browser_fixture") + "/Entities"; Assets.EnsureFolder(sourcePath);
            AssetDatabase.CopyAsset("Assets/BrowserFixture/Guard.prefab", sourcePath + "/npc_002.prefab");
            var catalog = MappingCatalog.Read(m);
            Check(catalog.levels == 2 && catalog.readable == 1 && catalog.warnings.Count == 1, "readable scope and unreadable source reported");
            Check(catalog.EntityIds(m).Count == 121 && catalog.entities.Count == 120, "known unmapped plus unknown saved IDs");
            Check(catalog.entities["npc_002"].blockout != null, "generated source preview asset resolved");
            Check(catalog.Status(m,"npc_001") == "Unmapped" && catalog.Status(m,"npc_002") == "Mapped", "mapped and unmapped states");
            Check(catalog.Status(m,"npc_003").Contains("duplicate") && m.entities.Count(e => e.entity == "npc_003") == 2, "duplicate rules flagged without mutation");
            Check(catalog.Status(m,"npc_004").Contains("missing"), "missing prefab invalid");
            Check(catalog.Filter(m,"",4).SequenceEqual(new[] { "unknown_manual" }), "unknown IDs independent of mapping status");
            Check(catalog.Filter(m,"gUaRd",0).Count == 3 && catalog.Filter(m,"NPC 001",0).Single() == "npc_001", "case-insensitive prefab and display-name search");
            Check(catalog.Filter(m,"npc_002",1).Count == 1 && catalog.Filter(m,"",3).Count == 2, "ID search and invalid filter");
            Check(catalog.tags.Contains("unmapped_tag") && catalog.colors["blue"].b > .9f, "tag and palette catalog");
            var watch = System.Diagnostics.Stopwatch.StartNew(); for(int i=0;i<100;i++) catalog.Filter(m,"npc",0); watch.Stop();
            File.WriteAllText(Path.Combine(Root,"filter-metrics.txt"), $"121 entries, 100 iterations, mean {watch.Elapsed.TotalMilliseconds/100:F3} ms\n");
            var window = OrlaMappingBrowser.Open(m); window.position = new Rect(50,50,1100,740);
            Check(level.exportId == 17 && level.transform.childCount == 0, "opening browser does not sync");
            Set(window,"selected","npc_001"); Check(m.entities.Count == 5, "selecting unmapped creates no rule");
            Undo.ClearAll(); Call(window,"AddRule","manual_new"); Undo.FlushUndoRecordObjects();
            Check(m.entities.Count == 6 && EditorUtility.IsDirty(m), "manual rule addition dirty tracking");
            Undo.PerformUndo(); Check(m.entities.Count == 5, "add rule Undo"); Undo.PerformRedo(); Check(m.entities.Count == 6, "add rule Redo");
            Undo.ClearAll();
            var so = new SerializedObject(m); so.Update();
            var row = so.FindProperty("entities").GetArrayElementAtIndex(0); row.FindPropertyRelative("scale").floatValue = 3.5f; row.FindPropertyRelative("offset").vector3Value = Vector3.one; so.ApplyModifiedProperties();
            Undo.PerformUndo(); Check(m.entities[0].scale == 1.2f && m.entities[0].offset == new Vector3(1,2,3), "serialized calibration Undo");
            Undo.PerformRedo(); Check(m.entities[0].scale == 3.5f && m.entities[0].offset == Vector3.one, "serialized calibration Redo");
            Set(window,"tab",1); Call(window,"AddRule","#manual_tag"); Check(m.tags.Last().tag == "manual_tag", "manual tag normalization");
            Set(window,"tab",2); Call(window,"AddRule","unknown_color"); Check(m.colors.Last().color == "unknown_color", "manual color without palette");
            Check(m.tags[0].setLayer && m.tags[0].layer == 8 && m.tags[0].unityTag == "MissingGameTag" && m.tags[0].staticFlags == 4 && m.tags[0].keepInBuilds && m.tags[0].components.Count == 2 && m.colors[0].floor == mat, "all legacy tag/color fields retained");
            Undo.ClearAll(); so = new SerializedObject(m); so.Update();
            so.FindProperty("tags").GetArrayElementAtIndex(0).FindPropertyRelative("keepInBuilds").boolValue = false;
            so.FindProperty("colors").GetArrayElementAtIndex(0).FindPropertyRelative("floor").objectReferenceValue = null; so.ApplyModifiedProperties();
            Undo.PerformUndo(); Check(m.tags[0].keepInBuilds && m.colors[0].floor == mat, "tag and color edits Undo");
            Undo.PerformRedo(); Check(!m.tags[0].keepInBuilds && m.colors[0].floor == null, "tag and color edits Redo");
            Undo.PerformUndo();
            Undo.ClearAll(); Call(window,"Edit", (Action)(() => m.entities.RemoveAt(m.entities.Count - 1))); Undo.FlushUndoRecordObjects();
            Check(m.entities.Count == 5, "explicit remove mapping"); Undo.PerformUndo(); Check(m.entities.Count == 6, "remove Undo restores exact rule");
            AssetDatabase.DeleteAsset("Assets/BrowserFixture/Guard.prefab");
            Check(catalog.Filter(m,"npc",0).Count == 120 && catalog.Status(m,"npc_002").Contains("missing"), "deleted prefab fake-null safely searched");
            window.Close();
            EditorUtility.SetDirty(m); AssetDatabase.SaveAssets(); EditorSceneManager.SaveScene(level.gameObject.scene, "Assets/BrowserFixture/Catalog.unity");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            catalog = MappingCatalog.Read(m); Check(catalog.levels == 0 && catalog.EntityIds(m).Count == 5 && catalog.Filter(m,"",4).Count == 5, "unloaded Levels leave saved mappings editable");
            EditorSceneManager.OpenScene("Assets/BrowserFixture/Catalog.unity"); m = AssetDatabase.LoadAssetAtPath<OrlaMappings>("Assets/BrowserFixture/Mappings.asset");
            Check(MappingCatalog.Read(m).entities.Count == 120 && m.entities[0].scale == 3.5f && m.tags[0].components[1].StartsWith("Missing.Component"), "save/reopen preserves catalog associations and serialized settings");
            File.WriteAllText(Path.Combine(Root,"browser-result.json"), $"{{\"passed\":true,\"checks\":{checks}}}"); EditorApplication.Exit(0);
        }
        catch(Exception e) { Debug.LogException(e); File.WriteAllText(Path.Combine(Root,"browser-result.json"), JsonUtility.ToJson(new Failure { error = e.ToString() })); EditorApplication.Exit(1); }
    }
    [Serializable] class Failure { public bool passed = false; public string error; }
    static OrlaMappingBrowser guiWindow;
    static int stage, startDraw;
    static double deadline;
    static string guiError;
    static readonly System.Collections.Generic.List<string> guiMetrics = new System.Collections.Generic.List<string>();
    public static void RunGUI()
    {
        EditorApplication.delayCall += () =>
        {
            ScratchOnly();
            EditorSceneManager.OpenScene("Assets/BrowserFixture/Catalog.unity");
            var m = AssetDatabase.LoadAssetAtPath<OrlaMappings>("Assets/BrowserFixture/Mappings.asset");
            var root = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            var prefab = PrefabUtility.SaveAsPrefabAsset(root,"Assets/BrowserFixture/Guard.prefab"); UnityEngine.Object.DestroyImmediate(root);
            m.entities[0].prefab = prefab; EditorUtility.SetDirty(m); AssetDatabase.SaveAssets();
            guiWindow = OrlaMappingBrowser.Open(m); stage = 0;
            Application.logMessageReceived += GuiLog;
            ConfigureGUI(); EditorApplication.update += TickGUI;
        };
    }
    static void GuiLog(string message, string stack, LogType type)
    {
        if ((type == LogType.Exception || type == LogType.Error) && (stack.Contains("OrlaMappingBrowser") || stack.Contains("MappingCatalog"))) guiError = message + "\n" + stack;
    }
    static void ConfigureGUI()
    {
        Set(guiWindow,"tab",stage == 2 ? 1 : stage == 3 ? 2 : 0);
        Set(guiWindow,"selected", stage == 2 ? "npc" : stage == 3 ? "blue" : "npc_002");
        Set(guiWindow,"scroll",stage == 4 ? new Vector2(0,3000) : Vector2.zero);
        Set(guiWindow,"showSources",stage == 1);
        guiWindow.position = new Rect(40,40,stage == 1 || stage == 2 ? 360 : 1100,740);
        Call(guiWindow,"Invalidate"); startDraw = guiWindow.DrawCount; deadline = EditorApplication.timeSinceStartup + 25;
        guiWindow.Repaint();
    }
    static void TickGUI()
    {
        try
        {
            if (guiError != null) throw new Exception(guiError);
            if (EditorApplication.timeSinceStartup > deadline) throw new Exception("No IMGUI layout/repaint events before deadline at stage " + stage);
            guiWindow.Repaint();
            guiWindow.SendEvent(new Event { type = EventType.Layout });
            guiWindow.SendEvent(new Event { type = EventType.Repaint });
            if (guiWindow.DrawCount - startDraw < 12) return;
            Check(guiWindow.VisibleCards > 0 && guiWindow.VisibleCards < 121, "virtualized IMGUI cards at stage " + stage);
            Check(guiWindow.PreviewRequests <= guiWindow.VisibleCards * 2, "preview requests bounded to visible entries at stage " + stage);
            guiMetrics.Add($"stage {stage}: width {guiWindow.position.width}, cards {guiWindow.VisibleCards}, preview assets {guiWindow.PreviewRequests}, last draw {guiWindow.LastDrawMs:F3} ms");
            if (++stage < 5) { ConfigureGUI(); return; }
            File.WriteAllLines(Path.Combine(Root,"gui-metrics.txt"), guiMetrics);
            File.WriteAllText(Path.Combine(Root,"gui-result.json"), "{\"passed\":true,\"stages\":5}");
            EditorApplication.update -= TickGUI; Application.logMessageReceived -= GuiLog; guiWindow.Close(); EditorApplication.Exit(0);
        }
        catch(Exception e)
        {
            Debug.LogException(e); File.WriteAllText(Path.Combine(Root,"gui-result.json"),JsonUtility.ToJson(new Failure { error = e.ToString() }));
            EditorApplication.update -= TickGUI; Application.logMessageReceived -= GuiLog; EditorApplication.Exit(1);
        }
    }
    public static void Open()
    {
        EditorApplication.delayCall += () => { ScratchOnly(); EditorSceneManager.OpenScene("Assets/BrowserFixture/Catalog.unity"); var window = OrlaMappingBrowser.Open(AssetDatabase.LoadAssetAtPath<OrlaMappings>("Assets/BrowserFixture/Mappings.asset")); window.position = new Rect(50,50,1100,740); };
    }
}
