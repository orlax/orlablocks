using System;
using System.IO;
using System.Linq;
using Orlablocks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace OrlablocksPrototype
{
    public static class MappingPrototypeChecks
    {
        static int checks;
        static GameObject blockout, guard, merchant;
        static void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; Debug.Log("MAPPING_CHECK " + message); }
        static void ScratchOnly()
        {
            if (!Path.GetFullPath(Application.dataPath).StartsWith("/private/tmp/orla-mappings-18-")) throw new Exception("This experiment runs only in /private/tmp/orla-mappings-18-* projects.");
        }
        public static void Run() { EditorApplication.delayCall += Checks; }
        public static void Open() { EditorApplication.delayCall += () => { ScratchOnly(); OpenBrowser(); }; }
        static GameObject Prefab(string name, PrimitiveType shape, Color color, Vector3 pivotOffset)
        {
            var root = new GameObject(name);
            var visual = GameObject.CreatePrimitive(shape); visual.transform.SetParent(root.transform, false);
            visual.transform.localPosition = pivotOffset;
            var material = new Material(Shader.Find("Standard")); material.color = color;
            AssetDatabase.CreateAsset(material, "Assets/Fixture/" + name + ".mat");
            visual.GetComponent<Renderer>().sharedMaterial = material;
            var prefab = PrefabUtility.SaveAsPrefabAsset(root, "Assets/Fixture/" + name + ".prefab");
            UnityEngine.Object.DestroyImmediate(root); return prefab;
        }
        static PrototypePlacement Placement(string id, Vector3 position)
        {
            var go = new GameObject(id); go.transform.position = position;
            var n = go.AddComponent<OrlaNode>(); n.id = id; n.entity = "npc"; n.type = "instance";
            var p = go.AddComponent<PrototypePlacement>(); p.inheritedPrefab = blockout; p.blockoutPrefab = blockout;
            p.inherited.offset = new Vector3(.25f, .5f, -.1f); p.inherited.rotation = new Vector3(0, 20, 0); p.inherited.scale = 1.2f;
            PlacementExperiment.Apply(p, null, true); return p;
        }
        static PrototypePlacement Find(string id) => UnityEngine.Object.FindObjectsByType<PrototypePlacement>(FindObjectsInactive.Include).First(p => p.name == id);
        static void Checks()
        {
            try
            {
                ScratchOnly(); EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                Directory.CreateDirectory("Assets/Fixture"); AssetDatabase.Refresh();
                blockout = Prefab("NPC blockout", PrimitiveType.Capsule, Color.gray, Vector3.up);
                guard = Prefab("Guard — floor pivot", PrimitiveType.Cube, new Color(.2f,.5f,.9f), Vector3.up);
                merchant = Prefab("Merchant — center pivot", PrimitiveType.Sphere, new Color(.9f,.55f,.2f), Vector3.zero);
                var a = Placement("instance_1", new Vector3(-3,0,0));
                var b = Placement("instance_2", Vector3.zero); var c = Placement("instance_3", new Vector3(3,0,0));
                var rootComponent = a.gameObject.AddComponent<AudioSource>();
                var userChild = new GameObject("Gameplay child"); userChild.transform.SetParent(a.transform, false);
                var references = new GameObject("Gameplay references").AddComponent<PrototypeReference>();
                references.placement = a.gameObject; references.rootComponent = rootComponent;
                references.internalComponent = a.managedChild.GetComponentInChildren<Collider>();
                var oldInternal = references.internalComponent;
                PlacementExperiment.Apply(a, guard); PlacementExperiment.Apply(b, merchant);
                Check(a.managedChild != b.managedChild && !c.overridden, "two different NPC prefabs and one inherited placement");
                Check(references.placement == a.gameObject && references.rootComponent == rootComponent && userChild.transform.parent == a.transform, "stable root references, components and user children survive swaps");
                Check(oldInternal == null && references.internalComponent == null, "internal prefab component reference cannot survive replacement (documented limitation)");
                Check(a.replacement.offset == a.inherited.offset && b.replacement.offset == b.inherited.offset, "initial calibration copied verbatim for both prefab pivots");
                var floor = a.managedChild.GetComponentInChildren<Collider>().bounds.min.y;
                var center = b.managedChild.GetComponentInChildren<Collider>().bounds.min.y;
                Check(Mathf.Abs(floor - center) > .1f, "different pivots need local calibration; inherited values are only a starting point");
                var childB = b.managedChild; var childC = c.managedChild;
                Undo.ClearAll(); PlacementExperiment.Apply(a, null, true);
                Check(!a.overridden && PrefabUtility.GetCorrespondingObjectFromSource(a.managedChild) == blockout, "Clear immediately restores inheritance");
                Undo.PerformUndo(); Check(a.overridden && a.replacement.prefab == guard && a.managedChild != null, "one Undo restores settings and managed child");
                Undo.PerformRedo(); Check(!a.overridden && a.replacement.prefab == null, "one Redo clears settings and replaces content");
                Check(b.managedChild == childB && c.managedChild == childC, "node operation leaves unrelated placements intact");
                var beforeFailure = a.managedChild; bool failed = false;
                try { PlacementExperiment.Apply(a, guard, false, true); } catch { failed = true; }
                Check(failed && a.managedChild == beforeFailure && !a.overridden && a.transform.childCount == 2, "failed replacement after destruction restores original content and state");
                a.GetComponent<OrlaNode>().claimed = true;
                Check(PlacementExperiment.Conflict(a).Contains("Unclaim"), "Claim blocks immediate replacement"); a.GetComponent<OrlaNode>().claimed = false;
                a.transform.position += Vector3.up * 2; var drift = a.transform.position;
                PlacementExperiment.Apply(a, guard); Check(a.transform.position == drift, "representation-only edit preserves local parent drift");
                a.transform.localScale = Vector3.one * 2; a.transform.rotation = Quaternion.Euler(0, 35, 0);
                a.replacement.blockout = OrlaMappings.Blockout.Keep; PlacementExperiment.Apply(a, merchant);
                Check(a.managedBlockout.transform.localPosition == Vector3.zero && a.managedBlockout.transform.localRotation == Quaternion.identity && a.managedBlockout.transform.localScale == Vector3.one, "kept blockout is a sibling at source pivot under scaled and rotated parent");
                a.managedChild.GetComponentInChildren<Collider>().enabled = false;
                PrefabUtility.RecordPrefabInstancePropertyModifications(a.managedChild.GetComponentInChildren<Collider>());
                Check(PlacementExperiment.Conflict(a) != null, "component edits in managed prefab block a destructive swap");
                var editedChild = a.managedChild; failed = false;
                try { PlacementExperiment.Apply(a, guard); } catch { failed = true; }
                Check(failed && a.managedChild == editedChild, "conflicted representation retained");
                PrefabUtility.RevertPrefabInstance(a.managedChild, InteractionMode.AutomatedAction);
                // Reverting local prefab edits also reverts nondefault root scale. Reconcile calibration
                // through the same operation before testing save/reopen persistence.
                PlacementExperiment.Apply(a, a.replacement.prefab);
                a.GetComponent<OrlaNode>().entity = "different";
                Check(PlacementExperiment.Conflict(a).Contains("entity changed"), "changed entity is invalidated for review"); a.GetComponent<OrlaNode>().entity = "npc";
                var legacy = (GameObject)PrefabUtility.InstantiatePrefab(guard);
                var legacyNode = legacy.AddComponent<OrlaNode>(); legacyNode.type = "instance"; legacyNode.id = "legacy_instance";
                var legacyAudio = legacy.AddComponent<AudioSource>();
                var legacyAddition = new GameObject("Legacy user child"); legacyAddition.transform.SetParent(legacy.transform);
                legacy.GetComponentInChildren<Collider>().enabled = false;
                PrefabUtility.RecordPrefabInstancePropertyModifications(legacy.GetComponentInChildren<Collider>());
                var legacyReferences = new GameObject("Legacy references").AddComponent<PrototypeReference>();
                legacyReferences.placement = legacy; legacyReferences.rootComponent = legacyAudio;
                Check(PlacementExperiment.LegacyConflict(legacyNode) != null, "legacy prefab root requires explicit migration resolution");
                Check(legacyReferences.placement == legacy && legacyReferences.rootComponent == legacyAudio && legacyAddition.transform.parent == legacy.transform
                    && PrefabUtility.IsPartOfPrefabInstance(legacy) && !legacy.GetComponentInChildren<Collider>().enabled, "migration conflict retains prefab connection, local edits, root components, child and references");
                var mappings = ScriptableObject.CreateInstance<OrlaMappings>();
                for (int i = 0; i < 120; i++) if (i % 4 != 0) mappings.entities.Add(new OrlaMappings.EntityMapping { entity = $"npc_{i:000}", prefab = i % 9 == 0 ? null : i % 2 == 0 ? guard : merchant });
                mappings.entities.Add(new OrlaMappings.EntityMapping { entity = "unknown_saved", prefab = guard });
                mappings.entities.Add(new OrlaMappings.EntityMapping { entity = "npc_001", prefab = guard });
                AssetDatabase.CreateAsset(mappings, "Assets/Fixture/Mappings.asset");
                var window = Configure(mappings);
                Check(window.Catalog().Count == 121 && window.Status("npc_000") == "Unmapped", "catalog includes known unmapped entities and unknown saved IDs");
                Check(window.Status("npc_001").Contains("duplicate") && window.Status("npc_009").Contains("missing"), "duplicate and missing prefab rules remain explicit");
                Check(window.Status("unknown_saved") == "Not in available exports", "absent ID is not described as deleted");
                var watch = System.Diagnostics.Stopwatch.StartNew(); for (int i = 0; i < 100; i++) window.Filtered(); watch.Stop();
                double filterMs = watch.Elapsed.TotalMilliseconds / 100;
                AssetDatabase.SaveAssets(); EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(), "Assets/Fixture/NPCs.unity");
                EditorSceneManager.OpenScene("Assets/Fixture/NPCs.unity"); a = Find("instance_1");
                references = GameObject.Find("Gameplay references").GetComponent<PrototypeReference>();
                Check(a.overridden && a.replacement.prefab == merchant && a.managedChild != null && a.managedBlockout != null, "save/reopen preserves local settings and explicit managed references");
                Check(a.managedChild.transform.localPosition == a.replacement.offset && Quaternion.Angle(a.managedChild.transform.localRotation, Quaternion.Euler(a.replacement.rotation)) < .01f
                    && a.managedChild.transform.localScale == Vector3.one * a.replacement.scale, "save/reopen preserves managed prefab calibration transforms");
                Check(a.managedBlockout.transform.localPosition == Vector3.zero && a.managedBlockout.activeSelf, "save/reopen preserves kept-blockout alignment and visibility");
                Check(references.placement == a.gameObject && references.rootComponent == a.GetComponent<AudioSource>(), "serialized gameplay root references survive reload");
                File.WriteAllText("result.json", $"{{\"passed\":true,\"checks\":{checks},\"catalogEntries\":121,\"filterMeanMs\":{filterMs.ToString(System.Globalization.CultureInfo.InvariantCulture)}}}");
                Debug.Log("MAPPING_PROTOTYPE_PASS " + checks);
                EditorApplication.Exit(0);
            }
            catch (Exception e) { Debug.LogException(e); File.WriteAllText("result.json", JsonUtility.ToJson(new Failure { error = e.ToString() })); EditorApplication.Exit(1); }
        }
        [Serializable] class Failure { public string error; }
        static MappingBrowserPrototype Configure(OrlaMappings mappings)
        {
            var window = EditorWindow.GetWindow<MappingBrowserPrototype>(); window.mappings = mappings;
            window.blockout = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/NPC blockout.prefab");
            window.knownIds = Enumerable.Range(0,120).Select(i => $"npc_{i:000}").ToArray();
            window.knownNames = Enumerable.Range(0,120).Select(i => new[] { "Villager", "Guard", "Merchant", "Scout" }[i%4] + $" {i+1:000}").ToArray();
            window.position = new Rect(140,100,1100,720); window.Show(); return window;
        }
        static void OpenBrowser() { Configure(AssetDatabase.LoadAssetAtPath<OrlaMappings>("Assets/Fixture/Mappings.asset")); }
    }
}
