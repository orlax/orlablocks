#if ORLA_PROBUILDER
using System;
using System.Linq;
using UnityEditor;
using UnityEditor.ProBuilder;
using UnityEngine;
using UnityEngine.ProBuilder;
using UnityEngine.ProBuilder.MeshOperations;

namespace Orlablocks.Editor
{
    /// <summary>
    /// Claim as ProBuilder (plan 15 §8): a synced shape becomes a ProBuilder mesh you can edit in Unity, and it's
    /// claimed, so syncs leave it alone from then on. Only with ProBuilder installed (the editor assembly's
    /// ORLA_PROBUILDER define comes from the com.unity.probuilder package). One undo step.
    /// </summary>
    public static class ProBuilderClaim
    {
        /// <summary>Synced shapes of the Level itself: an entity's parts are its prefab's, so they're left out.</summary>
        static GameObject[] Shapes() =>
            Selection.gameObjects
                .Where(g =>
                {
                    var n = g.GetComponent<OrlaNode>();
                    return n != null && n.kind != "hole" && g.GetComponent<MeshFilter>() != null && g.GetComponent<MeshRenderer>() != null
                        && g.GetComponent<ProBuilderMesh>() == null && !PrefabUtility.IsPartOfPrefabInstance(g);
                })
                .ToArray();

        [MenuItem("GameObject/Orlablocks/Claim as ProBuilder", false, 14)]
        static void Claim()
        {
            var shapes = Shapes();
            Undo.IncrementCurrentGroup();
            var group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Claim as ProBuilder");
            Nodes.Claim(shapes, true);
            // The import smooths faces meeting at under 30°, as orlablocks' creased normals do.
            var settings = new MeshImportSettings { quads = true, smoothing = true, smoothingAngle = 30f };
            foreach (var go in shapes)
            {
                var filter = go.GetComponent<MeshFilter>();
                var renderer = go.GetComponent<MeshRenderer>();
                try
                {
                    // ProBuilder can't edit a statically batched renderer.
                    Undo.RecordObject(go, "Claim as ProBuilder");
                    GameObjectUtility.SetStaticEditorFlags(go, GameObjectUtility.GetStaticEditorFlags(go) & ~StaticEditorFlags.BatchingStatic);
                    var pb = Undo.AddComponent<ProBuilderMesh>(go);
                    new MeshImporter(filter.sharedMesh, renderer.sharedMaterials, pb).Import(settings);
                    pb.ToMesh();
                    pb.Refresh();
                    pb.Optimize();
                    var collider = go.GetComponent<MeshCollider>();
                    if (collider != null)
                    {
                        Undo.RecordObject(collider, "Claim as ProBuilder");
                        collider.sharedMesh = filter.sharedMesh;
                    }
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"Orlablocks: {go.name} didn't become a ProBuilder mesh (it's still claimed).\n{e}", go);
                }
            }
            Undo.CollapseUndoOperations(group);
            ProBuilderEditor.Refresh();
        }

        [MenuItem("GameObject/Orlablocks/Claim as ProBuilder", true)]
        static bool CanClaim() => Shapes().Length > 0;
    }
}
#endif
