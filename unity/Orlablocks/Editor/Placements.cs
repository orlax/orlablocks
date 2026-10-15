using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    public static class Placements
    {
        public const string Legacy = "Legacy placement retained to protect components and references. Claim it, create a new source instance with a new ID, rebind gameplay to its stable parent, then retire the legacy object.";

        public static OrlaMappings.EntityMapping Effective(OrlaPlacement p, MappingSet mappings, string entity) =>
            p != null && p.overridden ? p.replacement : mappings.Entity(entity);

        public static string Revision(OrlaPlacement p) => p != null && p.overridden
            ? "|local:" + AssetId(p.replacement.prefab) + ":" + p.replacement.scale + ":" + p.replacement.offset.ToString("R") + ":" + p.replacement.rotation.ToString("R") + ":" + p.replacement.blockout + ":" + p.expectedEntity : "";

        // Compare the actual prefab overrides, including calibration, against what we last authored.
        // Asset IDs survive domain/scene reload; do not serialize transient instance IDs in this baseline.
        static string AssetId(UnityEngine.Object o) => o != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out string guid, out long local) ? guid + "/" + local : o != null ? o.GetType().FullName + ":scene-reference" : "";
        public static string Fingerprint(GameObject go)
        {
            if (go == null) return "";
            if (!PrefabUtility.IsPartOfPrefabInstance(go)) return "unpacked";
            var mods = (PrefabUtility.GetPropertyModifications(go) ?? Array.Empty<PropertyModification>())
                .Select(m => AssetId(m.target) + ":" + m.propertyPath + ":" + m.value + ":" + AssetId(m.objectReference)).OrderBy(s => s);
            return string.Join("\n", mods) + $"\nadded:{PrefabUtility.GetAddedComponents(go).Count}/{PrefabUtility.GetRemovedComponents(go).Count}/{PrefabUtility.GetAddedGameObjects(go).Count}/{PrefabUtility.GetRemovedGameObjects(go).Count}";
        }
        public static bool Edited(OrlaPlacement p) =>
            (p.managedChild != null && Fingerprint(p.managedChild) != p.childBaseline) ||
            (p.managedBlockout != null && Fingerprint(p.managedBlockout) != p.blockoutBaseline);

        public static string Gate(OrlaNode n)
        {
            if (EditorUtility.IsPersistent(n) || n.GetComponentInParent<OrlaLevel>() == null) return "Generated assets and entity-definition children cannot have local overrides.";
            var owner = n.GetComponentsInParent<OrlaPlacement>(true).FirstOrDefault(p => p.gameObject != n.gameObject);
            if (owner != null) return "Managed prefab content: select its owning placement parent.";
            if (string.IsNullOrEmpty(n.id)) return "This copied placement has no source identity and is outside Sync.";
            if (n.type != "instance") return "Only ordinary scene instances support overrides. Use separate instances for named NPCs; array items are ineligible.";
            if (n.GetComponent<OrlaPlacement>() == null) return Legacy;
            for (var t = n.transform; t != null; t = t.parent)
                if (t.GetComponent<OrlaNode>() is OrlaNode a && a.claimed) return "Unclaim this node and its ancestors before changing its representation.";
            return null;
        }

        public static void Set(OrlaNode n, GameObject prefab, bool clear = false, OrlaMappings.EntityMapping calibration = null)
        {
            var gate = Gate(n);
            if (gate != null) throw new InvalidOperationException(gate);
            if (!clear && (prefab == null || !EditorUtility.IsPersistent(prefab) || !PrefabUtility.IsPartOfPrefabAsset(prefab) || prefab.transform.parent != null))
                throw new InvalidOperationException("Choose a prefab asset.");
            var p = n.GetComponent<OrlaPlacement>();
            if (Edited(p)) throw new InvalidOperationException("Managed prefab content has local edits. Resolve or revert those edits before replacing it. References inside replaced content cannot be preserved.");
            var level = n.GetComponentInParent<OrlaLevel>();
            var m = Manifest.Read(Assets.FullPath(level.folder));
            if (p.project != m.project.id || p.scene != m.scene.id) throw new InvalidOperationException("Level source changed: restore the original source before editing this override.");
            var r = m.nodes.FirstOrDefault(r => r.id == n.id);
            if (!clear && (r == null || r.type != "instance")) throw new InvalidOperationException("Source instance is missing or changed type. Restore it or clear the override.");
            Undo.IncrementCurrentGroup(); var group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName(clear ? "Clear override" : "Override prefab");
            try
            {
                var settings = calibration ?? (p.overridden ? p.replacement : new MappingSet(level.mappings, new System.Collections.Generic.List<string>()).Entity(n.entity));
                Undo.RegisterCompleteObjectUndo(p, "Override prefab");
                p.replacement = new OrlaMappings.EntityMapping { prefab = clear ? null : prefab, scale = settings?.scale ?? 1, offset = settings?.offset ?? Vector3.zero,
                    rotation = settings?.rotation ?? Vector3.zero, blockout = settings?.blockout ?? OrlaMappings.Blockout.Replace };
                p.overridden = !clear; p.expectedEntity = clear ? "" : r.entity;
                if (r != null && r.type == "instance") Sync.ApplyPlacement(level, m, r, n);
                else { Undo.RecordObject(p, "Clear override"); p.problem = "Source missing or changed type; normal deletion/conversion resumes on the next Sync."; }
                EditorUtility.SetDirty(p);
                Undo.FlushUndoRecordObjects(); Undo.CollapseUndoOperations(group);
            }
            catch { Undo.FlushUndoRecordObjects(); Undo.RevertAllDownToGroup(group); throw; }
        }
    }
}
