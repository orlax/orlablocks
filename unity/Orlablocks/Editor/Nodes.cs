using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// Claiming and reverting synced objects (plan 15 §7), from the node's inspector, the Level's lists and the
    /// GameObject menu (for a whole selection).
    /// </summary>
    public static class Nodes
    {
        /// <summary>Claims (or unclaims) objects: a claimed one, and what's under it, is left alone by syncs.</summary>
        public static void Claim(GameObject[] objects, bool claimed)
        {
            foreach (var go in objects)
            {
                var n = go != null ? go.GetComponent<OrlaNode>() : null;
                if (n == null || n.claimed == claimed) continue;
                Undo.RecordObject(n, claimed ? "Claim" : "Unclaim");
                n.claimed = claimed;
                EditorUtility.SetDirty(n);
            }
            // Unclaimed ones take orlablocks' version on the next sync; the lists refresh with it.
            foreach (var level in objects.Where(o => o != null).Select(o => o.GetComponentInParent<OrlaLevel>()).Distinct())
                if (level != null) Forget(level, objects);
        }

        /// <summary>Takes orlablocks' place back for objects moved in Unity: marks them and syncs their Levels.</summary>
        public static void Revert(GameObject[] objects)
        {
            foreach (var go in objects)
            {
                var n = go != null ? go.GetComponent<OrlaNode>() : null;
                if (n == null) continue;
                Undo.RecordObject(n, "Revert to orlablocks");
                n.revert = true;
            }
            foreach (var level in objects.Where(o => o != null).Select(o => o.GetComponentInParent<OrlaLevel>()).Distinct())
            {
                if (level == null) continue;
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

        /// <summary>Takes objects off a Level's lists (they've been claimed or unclaimed since).</summary>
        static void Forget(OrlaLevel level, GameObject[] objects)
        {
            Undo.RecordObject(level, "Claim");
            level.terrainChangedInUnity = level.terrainChangedInUnity.Where(o => o != null && !objects.Contains(o)).ToArray();
            level.movedInUnity = level.movedInUnity.Where(o => o != null && !objects.Contains(o)).ToArray();
            level.claimedChanged = level.claimedChanged.Where(o => o != null && !objects.Contains(o)).ToArray();
            EditorUtility.SetDirty(level);
        }

        [MenuItem("GameObject/Orlablocks/Select owning placement", false, 14)]
        static void SelectPlacement()
        {
            var p = Selection.activeGameObject != null ? Selection.activeGameObject.GetComponentInParent<OrlaPlacement>(true) : null;
            if (p != null) Selection.activeGameObject = p.gameObject;
        }

        static GameObject[] Synced() => Selection.gameObjects.Where(g => g.GetComponent<OrlaNode>() != null).ToArray();

        [MenuItem("GameObject/Orlablocks/Claim", false, 11)]
        static void ClaimSelection() => Claim(Synced(), true);

        [MenuItem("GameObject/Orlablocks/Unclaim", false, 12)]
        static void UnclaimSelection() => Claim(Synced(), false);

        [MenuItem("GameObject/Orlablocks/Revert to orlablocks", false, 13)]
        static void RevertSelection() => Revert(Synced());

        [MenuItem("GameObject/Orlablocks/Claim", true)]
        [MenuItem("GameObject/Orlablocks/Unclaim", true)]
        [MenuItem("GameObject/Orlablocks/Revert to orlablocks", true)]
        static bool HasSynced() => Synced().Length > 0;
    }

    /// <summary>A synced object's inspector: its fields, whether it's claimed, and whether it was moved in Unity.</summary>
    [CustomEditor(typeof(OrlaNode))]
    [CanEditMultipleObjects]
    public class OrlaNodeEditor : UnityEditor.Editor
    {
        string overrideError;
        bool calibrationOpen;
        void OverrideUI(OrlaNode node)
        {
            var owner = node.GetComponentsInParent<OrlaPlacement>(true).FirstOrDefault(p => p.gameObject != node.gameObject);
            if (owner != null && GUILayout.Button("Select owning placement")) Selection.activeGameObject = owner.gameObject;
            var gate = Placements.Gate(node);
            var p = node.GetComponent<OrlaPlacement>();
            if (gate != null) EditorGUILayout.HelpBox(gate, MessageType.Info);
            if (p != null && !string.IsNullOrEmpty(p.problem)) EditorGUILayout.HelpBox(p.problem, MessageType.Warning);
            if (overrideError != null) EditorGUILayout.HelpBox(overrideError, MessageType.Error);
            using (new EditorGUI.DisabledScope(gate != null || targets.Length != 1))
            {
                var current = p != null && p.overridden ? p.replacement.prefab : null;
                EditorGUI.BeginChangeCheck();
                var selected = (GameObject)EditorGUILayout.ObjectField(
                    new GUIContent("Override prefab", "Assign a prefab asset to replace this instance immediately. Empty restores inheritance."),
                    current, typeof(GameObject), false);
                if (EditorGUI.EndChangeCheck() && selected != current)
                {
                    TryOverride(node, selected, selected == null);
                    GUIUtility.ExitGUI();
                }
                if (p != null && p.overridden)
                {
                    if (GUILayout.Button("Clear override"))
                    {
                        TryOverride(node, null, true);
                        GUIUtility.ExitGUI();
                    }
                    calibrationOpen = EditorGUILayout.Foldout(calibrationOpen, "Calibration", true);
                    if (calibrationOpen)
                    {
                        EditorGUI.BeginChangeCheck();
                        var settings = new OrlaMappings.EntityMapping { prefab = p.replacement.prefab,
                            scale = EditorGUILayout.FloatField("Scale", p.replacement.scale),
                            offset = EditorGUILayout.Vector3Field("Position offset", p.replacement.offset),
                            rotation = EditorGUILayout.Vector3Field("Rotation offset", p.replacement.rotation),
                            blockout = (OrlaMappings.Blockout)EditorGUILayout.EnumPopup("Blockout", p.replacement.blockout) };
                        if (EditorGUI.EndChangeCheck()) TryOverride(node, settings.prefab, false, settings);
                    }
                }
            }
            if (p != null) EditorGUILayout.HelpBox("Reference this placement parent from gameplay. References inside a replaced prefab cannot survive replacement. Resolve local prefab edits before swapping.", MessageType.Info);
        }
        void TryOverride(OrlaNode node, GameObject prefab, bool clear, OrlaMappings.EntityMapping settings = null)
        {
            try { Placements.Set(node, prefab, clear, settings); overrideError = null; }
            catch (Exception e) { overrideError = e.Message; }
        }
        public override void OnInspectorGUI()
        {
            var node = (OrlaNode)target;
            if (node.type != "entity" && !string.IsNullOrEmpty(node.id))
            {
                var gos = targets.Select(t => ((OrlaNode)t).gameObject).ToArray();
                if (node.claimed)
                {
                    EditorGUILayout.HelpBox("Claimed: this and what's under it are yours. Syncs leave them alone.", MessageType.Info);
                    if (GUILayout.Button("Unclaim (resume sync; local edits may need Revert)")) Nodes.Claim(gos, false);
                }
                else
                {
                    var level = node.GetComponentInParent<OrlaLevel>();
                    if (level != null && (level.movedInUnity.Contains(node.gameObject) || level.terrainChangedInUnity.Contains(node.gameObject)))
                    {
                        EditorGUILayout.HelpBox("Transform or terrain content edited in Unity since the last sync: syncs leave it alone.", MessageType.Warning);
                        using (new EditorGUILayout.HorizontalScope())
                        {
                            if (GUILayout.Button("Revert to orlablocks")) Nodes.Revert(gos);
                            if (GUILayout.Button("Claim")) Nodes.Claim(gos, true);
                        }
                    }
                    else if (GUILayout.Button(new GUIContent("Claim", "Make this and what's under it yours: syncs stop changing them"))) Nodes.Claim(gos, true);
                }
                EditorGUILayout.Space();
            }
            OverrideUI(node);
            using (new EditorGUI.DisabledScope(true)) DrawDefaultInspector();
        }
    }
}
