using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// Notices new exports (plan 15 §7): about once a second it looks at each open Level's level.json (its
    /// modification time, then the exportId at its start). A newer export shows Update available on the Level and
    /// in the Scene view; with Auto sync on, the Level syncs itself, never in Play mode or while scripts compile.
    /// </summary>
    [InitializeOnLoad]
    public static class Watcher
    {
        static double next;
        // By Level (a destroyed one's entries are dropped on the next look).
        static readonly Dictionary<OrlaLevel, (DateTime at, int exportId)> seen = new Dictionary<OrlaLevel, (DateTime, int)>();
        static readonly Dictionary<OrlaLevel, int> available = new Dictionary<OrlaLevel, int>();

        static Watcher()
        {
            EditorApplication.update += Tick;
            SceneView.duringSceneGui += DrawOverlay;
        }

        /// <summary>The newer export step waiting for this Level, or -1.</summary>
        public static int Available(OrlaLevel level) => level != null && available.TryGetValue(level, out var id) && id > level.exportId ? id : -1;

        static void Tick()
        {
            if (EditorApplication.timeSinceStartup < next) return;
            next = EditorApplication.timeSinceStartup + 1.0;
            var changed = false;
            foreach (var gone in new List<OrlaLevel>(seen.Keys))
                if (gone == null)
                {
                    seen.Remove(gone);
                    available.Remove(gone);
                }
            foreach (var level in UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Exclude))
            {
                if (string.IsNullOrEmpty(level.folder)) continue;
                var file = Path.Combine(Assets.FullPath(level.folder), "level.json");
                if (!File.Exists(file)) continue;
                var key = level;
                var at = File.GetLastWriteTimeUtc(file);
                if (!seen.TryGetValue(key, out var last) || last.at != at)
                {
                    var id = Manifest.PeekExportId(Path.GetDirectoryName(file));
                    if (id < 0) continue;
                    seen[key] = (at, id);
                    last = seen[key];
                }
                var was = Available(level);
                available[key] = last.exportId;
                var now = Available(level);
                if (now != was) changed = true;
                if (now >= 0 && level.autoSync && !Sync.FailedOn(level, now) && !EditorApplication.isPlayingOrWillChangePlaymode && !EditorApplication.isCompiling && !EditorApplication.isUpdating)
                {
                    try
                    {
                        Sync.Run(level, false);
                    }
                    catch (Exception e)
                    {
                        Debug.LogException(e, level);
                    }
                    changed = true;
                }
            }
            if (changed)
            {
                SceneView.RepaintAll();
                foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
                    if (w.GetType().Name == "InspectorWindow") w.Repaint();
            }
        }

        /// <summary>A small box in the Scene view's corner while a Level has a newer export, with Sync.</summary>
        static void DrawOverlay(SceneView view)
        {
            if (available.Count == 0) return;
            var waiting = new List<OrlaLevel>();
            foreach (var level in UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Exclude))
                if (Available(level) >= 0 && !level.autoSync) waiting.Add(level);
            if (waiting.Count == 0) return;
            Handles.BeginGUI();
            var height = 8 + 22 * waiting.Count;
            var rect = new Rect(10, view.position.height - height - 36, 300, height);
            GUI.Box(rect, GUIContent.none, EditorStyles.helpBox);
            for (int i = 0; i < waiting.Count; i++)
            {
                var row = new Rect(rect.x + 6, rect.y + 4 + 22 * i, rect.width - 12, 20);
                GUI.Label(new Rect(row.x, row.y, row.width - 60, row.height), $"orlablocks: {waiting[i].sceneName} has a new export");
                if (GUI.Button(new Rect(row.xMax - 56, row.y, 56, row.height), "Sync"))
                {
                    try
                    {
                        Sync.Run(waiting[i]);
                    }
                    catch (Exception e)
                    {
                        Debug.LogException(e, waiting[i]);
                    }
                }
            }
            Handles.EndGUI();
        }
    }
}
