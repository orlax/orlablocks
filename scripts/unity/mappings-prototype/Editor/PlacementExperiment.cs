using System;
using System.Linq;
using Orlablocks;
using UnityEditor;
using UnityEngine;

namespace OrlablocksPrototype
{
    public static class PlacementExperiment
    {
        public static string LegacyConflict(OrlaNode node) => node.GetComponent<PrototypePlacement>() == null
            ? "Legacy placement: retain content and references. Claim it and explicitly rebind gameplay to a new stable placement before retiring it."
            : null;

        public static string Conflict(PrototypePlacement p)
        {
            var n = p.GetComponent<OrlaNode>();
            if (n == null || n.type != "instance") return "Only ordinary scene instances are eligible.";
            if (n.entity != p.expectedEntity) return "Source entity changed: rebind or clear the override.";
            for (var t = p.transform; t != null; t = t.parent)
                if (t.GetComponent<OrlaNode>() is OrlaNode ancestor && ancestor.claimed) return "Unclaim before replacing.";
            if (p.managedChild != null && HasLocalEdits(p.managedChild)) return "Managed prefab has local edits. Keep it, or resolve the edits before replacing.";
            return null;
        }

        // Calibration on the managed root is ours; component edits, added/removed content and descendant
        // transforms belong to the user. This is deliberately conservative, not generic reference repair.
        public static bool HasLocalEdits(GameObject child)
        {
            if (!PrefabUtility.IsPartOfPrefabInstance(child)) return true;
            if (PrefabUtility.GetAddedComponents(child).Count > 0 || PrefabUtility.GetRemovedComponents(child).Count > 0
                || PrefabUtility.GetAddedGameObjects(child).Count > 0 || PrefabUtility.GetRemovedGameObjects(child).Count > 0) return true;
            var source = PrefabUtility.GetCorrespondingObjectFromSource(child.transform);
            var sourceObject = PrefabUtility.GetCorrespondingObjectFromSource(child);
            return (PrefabUtility.GetPropertyModifications(child) ?? Array.Empty<PropertyModification>()).Any(m =>
                !(m.target == sourceObject && m.propertyPath == "m_Name" && m.value == sourceObject.name) &&
                (m.target != source || !(m.propertyPath.StartsWith("m_LocalPosition.") || m.propertyPath.StartsWith("m_LocalRotation.")
                    || m.propertyPath.StartsWith("m_LocalScale.") || m.propertyPath.StartsWith("m_LocalEulerAnglesHint.") || m.propertyPath == "m_RootOrder")));
        }

        public static void Apply(PrototypePlacement p, GameObject prefab, bool clear = false, bool failAfterDestroy = false)
        {
            var conflict = Conflict(p);
            if (conflict != null) throw new InvalidOperationException(conflict);
            var chosen = clear ? p.inheritedPrefab : prefab;
            if (chosen == null || !PrefabUtility.IsPartOfPrefabAsset(chosen)) throw new InvalidOperationException("A valid prefab asset is required; existing content is retained.");
            Undo.IncrementCurrentGroup(); int group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName(clear ? "Clear override" : "Override prefab");
            try
            {
                Undo.RegisterCompleteObjectUndo(p, "Override prefab");
                var settings = clear ? p.inherited : p.overridden ? p.replacement : p.inherited;
                var next = (GameObject)PrefabUtility.InstantiatePrefab(chosen, p.transform);
                Undo.RegisterCreatedObjectUndo(next, "Override prefab");
                next.transform.localPosition = settings.offset;
                next.transform.localRotation = Quaternion.Euler(settings.rotation);
                next.transform.localScale = Vector3.one * (settings.scale > 0 ? settings.scale : 1);
                PrefabUtility.RecordPrefabInstancePropertyModifications(next.transform);
                if (p.managedChild != null) Undo.DestroyObjectImmediate(p.managedChild);
                if (p.managedBlockout != null) Undo.DestroyObjectImmediate(p.managedBlockout);
                if (failAfterDestroy) throw new InvalidOperationException("Injected replacement failure after removing old content");
                GameObject kept = null;
                if (settings.blockout != OrlaMappings.Blockout.Replace && p.blockoutPrefab != null)
                {
                    kept = (GameObject)PrefabUtility.InstantiatePrefab(p.blockoutPrefab, p.transform);
                    Undo.RegisterCreatedObjectUndo(kept, "Override prefab");
                    kept.transform.localPosition = Vector3.zero;
                    kept.transform.localRotation = Quaternion.identity;
                    kept.transform.localScale = Vector3.one;
                    kept.SetActive(settings.blockout == OrlaMappings.Blockout.Keep);
                    PrefabUtility.RecordPrefabInstancePropertyModifications(kept.transform);
                    PrefabUtility.RecordPrefabInstancePropertyModifications(kept);
                }
                // Creating/destroying GameObjects flushes Unity's current recorders. Resume recording
                // after those operations so Redo captures the final serialized state too.
                Undo.RecordObject(p, "Override prefab");
                p.managedChild = next; p.managedBlockout = kept;
                if (!clear && !p.overridden)
                    p.replacement = new OrlaMappings.EntityMapping { scale = settings.scale, offset = settings.offset, rotation = settings.rotation, blockout = settings.blockout };
                p.overridden = !clear;
                p.replacement.prefab = clear ? null : chosen;
                EditorUtility.SetDirty(p);
                Undo.FlushUndoRecordObjects();
                Undo.CollapseUndoOperations(group);
            }
            catch { Undo.FlushUndoRecordObjects(); Undo.RevertAllDownToGroup(group); throw; }
        }
    }

    [CustomEditor(typeof(PrototypePlacement))]
    public class PlacementExperimentEditor : UnityEditor.Editor
    {
        int picker;
        string error;
        public override void OnInspectorGUI()
        {
            var p = (PrototypePlacement)target;
            EditorGUILayout.HelpBox("18.1 scratch prototype — root references survive. References inside a replaced prefab cannot survive the swap.", MessageType.Info);
            var conflict = PlacementExperiment.Conflict(p);
            if (conflict != null) EditorGUILayout.HelpBox(conflict, MessageType.Warning);
            if (error != null) EditorGUILayout.HelpBox(error, MessageType.Error);
            using (new EditorGUI.DisabledScope(conflict != null))
            {
                if (GUILayout.Button("Override"))
                {
                    picker = GUIUtility.GetControlID(FocusType.Passive);
                    EditorGUIUtility.ShowObjectPicker<GameObject>(null, false, "t:Prefab", picker);
                }
                using (new EditorGUI.DisabledScope(true)) EditorGUILayout.ObjectField("Chosen prefab", p.overridden ? p.replacement.prefab : p.inheritedPrefab, typeof(GameObject), false);
                if (p.overridden && GUILayout.Button("Clear override")) TryApply(p, null, true);
            }
            // Apply only the final choice. Closing with no selected asset leaves state and Undo untouched.
            if (Event.current.commandName == "ObjectSelectorClosed" && EditorGUIUtility.GetObjectPickerControlID() == picker)
            {
                var selected = EditorGUIUtility.GetObjectPickerObject() as GameObject;
                if (selected != null) TryApply(p, selected, false);
                Event.current.Use();
            }
            EditorGUILayout.LabelField("Calibration is copied from inheritance on the first override.", EditorStyles.wordWrappedMiniLabel);
        }
        void TryApply(PrototypePlacement p, GameObject prefab, bool clear)
        {
            try { PlacementExperiment.Apply(p, prefab, clear); error = null; }
            catch (Exception e) { error = e.Message; }
        }
    }
}
