using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// The Orlablocks Level's inspector (plan 15 §6–§7): the scene's export folder with Choose…, Update available,
    /// Sync and Auto sync, the last sync's report, and what it left alone: objects moved in Unity (Revert or
    /// Claim), claimed objects changed or removed in orlablocks. GameObject → Orlablocks Level makes one.
    /// </summary>
    [CustomEditor(typeof(OrlaLevel))]
    public class OrlaLevelEditor : UnityEditor.Editor
    {
        string error;

        public override void OnInspectorGUI()
        {
            var level = (OrlaLevel)target;

            EditorGUILayout.LabelField("Export folder", EditorStyles.boldLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                var shown = string.IsNullOrEmpty(level.folder) ? "None: choose the scene's folder (it has level.json)" : level.folder;
                EditorGUILayout.SelectableLabel(shown, EditorStyles.textField, GUILayout.Height(EditorGUIUtility.singleLineHeight));
                if (GUILayout.Button("Choose…", GUILayout.Width(80))) ChooseFolder(level);
            }

            var available = Watcher.Available(level);
            if (available >= 0) EditorGUILayout.HelpBox($"Update available: orlablocks exported step {available} (this Level has step {level.exportId}).", MessageType.Info);

            EditorGUILayout.Space();
            using (new EditorGUI.DisabledScope(string.IsNullOrEmpty(level.folder)))
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Sync", GUILayout.Height(28))) Run(level, false);
                if (GUILayout.Button(new GUIContent("Rebuild materials", "Sync, and make the orla-* materials again from the palette (your changes to them are lost)"), GUILayout.Height(28), GUILayout.Width(130)))
                    Run(level, true);
            }
            var auto = EditorGUILayout.ToggleLeft(new GUIContent("Auto sync", "Sync on its own when orlablocks exports this scene again (at most once a second, never in Play mode)"), level.autoSync);
            if (auto != level.autoSync)
            {
                Undo.RecordObject(level, "Auto sync");
                level.autoSync = auto;
                EditorUtility.SetDirty(level);
            }
            if (!string.IsNullOrEmpty(error)) EditorGUILayout.HelpBox(error, MessageType.Error);

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                var picked = (OrlaMappings)EditorGUILayout.ObjectField(new GUIContent("Mappings", "Entities as your prefabs, tags as layers and components, colors as your materials"), level.mappings, typeof(OrlaMappings), false);
                if (picked != level.mappings) SetMappings(level, picked);
                if (level.mappings == null && GUILayout.Button(new GUIContent("New", "Make a mappings asset for this Level's project"), GUILayout.Width(50))) SetMappings(level, NewMappings(level));
            }

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("View", EditorStyles.boldLabel);
            Toggle(level, "Show notes", "Notes' text in the Scene view (a selected note always shows it)", level.showNotes, v => level.showNotes = v, true);
            Toggle(level, "Show holes", "Holes as wireframes in the Scene view (a selected hole always shows)", level.showHoles, v => level.showHoles = v, true);
            Toggle(level, "Lightmap UVs", "Lightmap UVs on the meshes and Contribute GI on the shapes, for baked lighting (syncs are slower; turning it on remakes every mesh once)", level.lightmapUVs, v => level.lightmapUVs = v, false);

            if (level.exportId >= 0)
            {
                EditorGUILayout.Space();
                EditorGUILayout.LabelField("Last sync", EditorStyles.boldLabel);
                EditorGUILayout.LabelField("Scene", $"{level.sceneName} ({level.sceneId})");
                EditorGUILayout.LabelField("Export step", level.exportId.ToString());
                EditorGUILayout.LabelField("Synced", level.syncedAt);
                if (!string.IsNullOrEmpty(level.report)) EditorGUILayout.HelpBox(level.report, MessageType.None);
            }

            List(level, "Moved in Unity", "Left where you put them. Revert takes orlablocks' place on the next sync; Claim makes them yours.", level.movedInUnity, true);
            List(level, "Claimed, changed in orlablocks", "Not updated, because they're claimed. Unclaim one to take orlablocks' version.", level.claimedChanged, false);
            List(level, "Claimed, gone from orlablocks", "Kept, because they're claimed.", level.goneFromOrlablocks, false);
        }

        void List(OrlaLevel level, string title, string help, GameObject[] objects, bool drift)
        {
            var live = (objects ?? new GameObject[0]).Where(o => o != null).ToArray();
            if (live.Length == 0) return;
            EditorGUILayout.Space();
            EditorGUILayout.LabelField($"{title} ({live.Length})", EditorStyles.boldLabel);
            EditorGUILayout.LabelField(help, EditorStyles.wordWrappedMiniLabel);
            foreach (var go in live)
                using (new EditorGUILayout.HorizontalScope())
                {
                    EditorGUILayout.ObjectField(go, typeof(GameObject), true);
                    if (!drift) continue;
                    if (GUILayout.Button("Revert", GUILayout.Width(60))) Nodes.Revert(new[] { go });
                    if (GUILayout.Button("Claim", GUILayout.Width(60))) Nodes.Claim(new[] { go }, true);
                }
            if (drift)
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.FlexibleSpace();
                    if (GUILayout.Button("Revert all", GUILayout.Width(80))) Nodes.Revert(live);
                    if (GUILayout.Button("Claim all", GUILayout.Width(80))) Nodes.Claim(live, true);
                }
        }

        static void Toggle(OrlaLevel level, string label, string tip, bool value, Action<bool> set, bool view)
        {
            var now = EditorGUILayout.ToggleLeft(new GUIContent(label, tip), value);
            if (now == value) return;
            Undo.RecordObject(level, label);
            set(now);
            EditorUtility.SetDirty(level);
            if (view) SceneView.RepaintAll();
        }

        static void SetMappings(OrlaLevel level, OrlaMappings mappings)
        {
            Undo.RecordObject(level, "Mappings");
            level.mappings = mappings;
            EditorUtility.SetDirty(level);
        }

        /// <summary>A new mappings asset in Assets/, named for the Level's project (not in the generated folder: it's yours).</summary>
        static OrlaMappings NewMappings(OrlaLevel level)
        {
            var name = string.IsNullOrEmpty(level.project) ? "Orlablocks Mappings" : $"Orlablocks Mappings ({level.project})";
            var path = AssetDatabase.GenerateUniqueAssetPath($"Assets/{name}.asset");
            var mappings = CreateInstance<OrlaMappings>();
            AssetDatabase.CreateAsset(mappings, path);
            AssetDatabase.SaveAssets();
            EditorGUIUtility.PingObject(mappings);
            return mappings;
        }

        void Run(OrlaLevel level, bool rebuildMaterials)
        {
            error = null;
            try
            {
                var result = Sync.Run(level, true, rebuildMaterials);
                if (result.Warnings.Count > 0) Debug.LogWarning($"Orlablocks sync of {level.sceneName}:\n{string.Join("\n", result.Warnings)}", level);
            }
            catch (Exception e)
            {
                error = e.Message;
                Debug.LogException(e, level);
            }
        }

        /// <summary>The folder dialog, starting where the Level points (or the Unity project). A pick is kept relative when it's inside the project.</summary>
        public static bool ChooseFolder(OrlaLevel level)
        {
            var start = Assets.FullPath(level.folder);
            if (string.IsNullOrEmpty(start) || !Directory.Exists(start)) start = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            var picked = EditorUtility.OpenFolderPanel("The scene's export folder (with level.json)", start, "");
            if (string.IsNullOrEmpty(picked)) return false;
            if (!File.Exists(Path.Combine(picked, "level.json")))
            {
                var inside = Directory.Exists(picked) ? Directory.GetDirectories(picked) : new string[0];
                var hint = Array.Exists(inside, d => File.Exists(Path.Combine(d, "level.json")))
                    ? " That looks like the project's export folder: pick one of the scene folders in it."
                    : "";
                EditorUtility.DisplayDialog("Orlablocks", $"There's no level.json in {picked}.{hint}", "OK");
                return false;
            }
            Undo.RecordObject(level, "Choose export folder");
            level.folder = Assets.StoredPath(picked);
            EditorUtility.SetDirty(level);
            return true;
        }

        [MenuItem("GameObject/Orlablocks Level", false, 10)]
        static void CreateLevel(MenuCommand command)
        {
            var go = new GameObject("Orlablocks Level");
            GameObjectUtility.SetParentAndAlign(go, command.context as GameObject);
            var level = go.AddComponent<OrlaLevel>();
            Undo.RegisterCreatedObjectUndo(go, "Create Orlablocks Level");
            Selection.activeObject = go;
            if (ChooseFolder(level))
            {
                try
                {
                    Sync.Run(level);
                }
                catch (Exception e)
                {
                    Debug.LogException(e, level);
                }
            }
        }
    }
}
