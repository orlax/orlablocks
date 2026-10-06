using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// Brings an Orlablocks Level up to date with its scene's export (plan 15 §6–§7), as one undo step.
    ///
    /// Each entity first, as a generated prefab: made when new, and edited in place (its children matched by ID)
    /// when its hash changed, so the instances' overrides still point at the same children. Then the Level's own
    /// objects, matched by ID:
    /// - a record whose rev the object already has is left alone (nothing is touched);
    /// - a changed one is updated in place: transform, parent, name, mesh, materials, collider;
    /// - a new one is made; a removed one is destroyed, what was added to it in Unity moved to "Orphaned (id)" first;
    /// - a claimed object (or anything under one) is never touched; one moved in Unity since the last sync (drift)
    ///   is left where it is and listed, until it's reverted or claimed.
    /// Everything is already in Unity's frame, so a sync only copies numbers.
    /// </summary>
    public static class Sync
    {
        public class Result
        {
            public bool UpToDate;
            public int Created, Updated, Unchanged, Removed, Orphaned, Instances, EntitiesBuilt, MeshesMade;
            public readonly List<GameObject> Moved = new List<GameObject>();
            public readonly List<GameObject> ClaimedChanged = new List<GameObject>();
            public readonly List<GameObject> Gone = new List<GameObject>();
            public readonly List<string> Warnings = new List<string>();
            // How long each part took (ms), for the report.
            public readonly List<(string part, long ms)> Timings = new List<(string, long)>();

            public string Report(Manifest m)
            {
                var lines = new List<string>
                {
                    $"{m.scene.name} ({m.project.name}), step {m.exportId}, exported {m.exportedAt}",
                    $"{Created} made, {Updated} updated, {Unchanged} unchanged, {Removed} removed" + (Orphaned > 0 ? $", {Orphaned} of your objects kept in Orphaned" : ""),
                    $"{m.entities.Length} entities ({EntitiesBuilt} rebuilt), {MeshesMade} new meshes",
                };
                if (Moved.Count > 0) lines.Add($"{Moved.Count} moved in Unity: left where they are (Revert or Claim them)");
                if (ClaimedChanged.Count > 0) lines.Add($"{ClaimedChanged.Count} claimed here changed in orlablocks: not updated");
                if (Gone.Count > 0) lines.Add($"{Gone.Count} claimed here are gone from orlablocks: kept");
                if (Timings.Count > 0)
                    lines.Add($"took {Timings.Sum(t => t.ms) / 1000.0:0.00} s: " + string.Join(", ", Timings.Select(t => $"{t.part} {t.ms / 1000.0:0.00}")));
                lines.AddRange(Warnings);
                return string.Join("\n", lines);
            }
        }

        /// <summary>What building records needs: where meshes go, the materials, the palette and the entity prefabs.</summary>
        class Context
        {
            public MeshBinary Bin;
            public string TerrainFolder;
            public MeshStore Store;
            public Look Look;
            public Dictionary<string, Color> Palette;
            public Dictionary<string, GameObject> Prefabs = new Dictionary<string, GameObject>();
            public Dictionary<string, string[]> EntityTags = new Dictionary<string, string[]>();
            public MappingSet Mappings;
            public bool LightmapUVs;
            public Result Result;

            /// <summary>
            /// A record's rev with what else shapes the objects (the mappings' fingerprint, lightmap UVs): changing
            /// either makes every object apply it once.
            /// </summary>
            public string Rev(string rev)
            {
                var salt = (Mappings?.Fingerprint ?? "") + (LightmapUVs ? ":uv2" : "");
                return salt.Length == 0 ? rev ?? "" : $"{rev}|{salt}";
            }

            /// <summary>A mesh from the binary, by its hash (with lightmap UVs, another mesh: its own key).</summary>
            public Mesh Mesh(string hash, params MeshRange[] parts)
            {
                var key = LightmapUVs ? $"{hash}~uv2" : hash;
                return Store.Get(key, () =>
                {
                    var mesh = Bin.Build(key, parts);
                    if (LightmapUVs) Unwrapping.GenerateSecondaryUVSet(mesh);
                    return mesh;
                });
            }

            public StaticEditorFlags Flags => Static | (LightmapUVs ? StaticEditorFlags.ContributeGI : 0);

            public Material Body(string color)
            {
                var own = Mappings?.Body(color);
                return own != null ? own : Look.Body(color);
            }

            public Material Floor(string color)
            {
                var own = Mappings?.Floor(color);
                return own != null ? own : Look.Floor(color);
            }
        }

        const StaticEditorFlags Static = StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccluderStatic | StaticEditorFlags.OccludeeStatic | StaticEditorFlags.ReflectionProbeStatic;

        // A Level's last sync, when it failed: the export it tried (-1 if it didn't get that far) and why.
        static readonly Dictionary<OrlaLevel, (int exportId, string message)> failures = new Dictionary<OrlaLevel, (int, string)>();

        /// <summary>Why the Level's last sync failed (however it was started), or null.</summary>
        public static string Failure(OrlaLevel level) => level != null && failures.TryGetValue(level, out var f) ? f.message : null;

        /// <summary>Whether the Level's last sync failed on this export (so Auto sync doesn't try it again every second).</summary>
        public static bool FailedOn(OrlaLevel level, int exportId) => level != null && failures.TryGetValue(level, out var f) && f.exportId == exportId;

        /// <param name="force">Sync even if the Level already has this export (it still leaves unchanged objects alone).</param>
        public static Result Run(OrlaLevel level, bool force = true, bool rebuildMaterials = false)
        {
            try
            {
                var result = RunOnce(level, force, rebuildMaterials);
                failures.Remove(level);
                return result;
            }
            catch (Exception e)
            {
                if (!failures.TryGetValue(level, out var f) || f.message != e.Message) failures[level] = (-1, e.Message);
                throw;
            }
        }

        static Result RunOnce(OrlaLevel level, bool force, bool rebuildMaterials)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var folder = Assets.FullPath(level.folder);
            if (string.IsNullOrEmpty(folder)) throw new Exception("Choose the scene's export folder first.");
            if (!force && Manifest.PeekExportId(folder) == level.exportId) return new Result { UpToDate = true };
            var m = Manifest.Read(folder);
            if (!force && m.exportId == level.exportId) return new Result { UpToDate = true };
            var bin = new MeshBinary(folder, m.meshes);
            var root = Assets.ProjectRoot(m.project.id);
            var result = new Result();
            void Lap(string part)
            {
                result.Timings.Add((part, clock.ElapsedMilliseconds));
                clock.Restart();
            }
            var ctx = new Context
            {
                Bin = bin,
                Look = new Look(root, m, rebuildMaterials),
                Palette = m.palette.ToDictionary(p => p.key, p => ColorUtility.TryParseHtmlString(p.color, out var c) ? c : Color.white),
                Result = result,
                Mappings = new MappingSet(level.mappings, result.Warnings),
                LightmapUVs = level.lightmapUVs,
            };
            foreach (var e in m.entities) ctx.EntityTags[e.id] = e.tags ?? new string[0];

            Undo.IncrementCurrentGroup();
            var group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName($"Sync {m.scene.name}");
            try
            {
                Lap("read");
                foreach (var e in m.entities) ctx.Prefabs[e.id] = EntityPrefab(e, root, ctx);
                Lap("entities");

                ctx.Store = new MeshStore($"{root}/Levels/{Assets.Safe(m.scene.id)}", true);
                ctx.TerrainFolder = $"{root}/Levels/{Assets.Safe(m.scene.id)}/Terrains";
                new Reconciler(level.transform, ctx, new Edit(true, $"Sync {m.scene.name}"), true).Run(m.nodes);
                Lap("objects");
                ctx.Store.KeepReferenced(level.gameObject);
                ctx.Store.Prune();
                ctx.Store.Save();
                // Rebuilt materials are the only other assets changed in place (new ones are written as they're made).
                if (rebuildMaterials) AssetDatabase.SaveAssets();
                Lap("meshes");
                result.MeshesMade += ctx.Store.Made;
                result.Warnings.AddRange(ctx.Look.Warnings);

                Undo.RecordObject(level, "Sync");
                level.project = m.project.id;
                level.sceneId = m.scene.id;
                level.sceneName = m.scene.name;
                level.exportId = m.exportId;
                level.syncedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                level.report = result.Report(m);
                level.movedInUnity = result.Moved.ToArray();
                level.claimedChanged = result.ClaimedChanged.ToArray();
                level.goneFromOrlablocks = result.Gone.ToArray();
                if (level.gameObject.name.StartsWith("Orlablocks Level"))
                {
                    Undo.RecordObject(level.gameObject, "Sync");
                    level.gameObject.name = $"Orlablocks Level · {m.scene.name}";
                }
                EditorUtility.SetDirty(level);
            }
            catch (Exception e)
            {
                // A sync that fails part way is taken back whole: the Level stays as the last sync left it (the
                // entity prefabs already rebuilt are kept; they're right for this export either way).
                Undo.RevertAllDownToGroup(group);
                failures[level] = (m.exportId, e.Message);
                throw;
            }
            finally
            {
                Undo.CollapseUndoOperations(group);
            }
            return result;
        }

        /// <summary>
        /// An entity's generated prefab: its shapes around its pivot. Untouched while its hash is the same; edited in
        /// place when it changed (so its children keep their identity, and the instances' overrides with them).
        /// </summary>
        static GameObject EntityPrefab(EntityRecord e, string root, Context ctx)
        {
            var path = $"{root}/Entities/{Assets.Safe(e.id)}.prefab";
            var existing = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            var known = existing != null ? existing.GetComponent<OrlaNode>() : null;
            // Its hash with the mappings' fingerprint: a color or tag mapping changes what's in it.
            var hash = ctx.Rev(e.hash);
            if (known != null && known.hash == hash) return existing;

            Assets.EnsureFolder($"{root}/Entities");
            var contents = existing != null ? PrefabUtility.LoadPrefabContents(path) : new GameObject();
            try
            {
                contents.name = string.IsNullOrEmpty(e.name) ? e.id : e.name;
                var own = contents.GetComponent<OrlaNode>();
                if (own == null) own = contents.AddComponent<OrlaNode>();
                own.id = e.id;
                own.type = "entity";
                own.description = e.description ?? "";
                own.tags = e.tags ?? new string[0];
                own.hash = hash;
                var entityCtx = new Context
                {
                    Bin = ctx.Bin,
                    Store = new MeshStore($"{root}/Entities/{Assets.Safe(e.id)}", false),
                    Look = ctx.Look,
                    Palette = ctx.Palette,
                    EntityTags = ctx.EntityTags,
                    Mappings = ctx.Mappings,
                    LightmapUVs = ctx.LightmapUVs,
                    Result = new Result(),
                };
                new Reconciler(contents.transform, entityCtx, new Edit(false, "Sync"), false).Run(e.nodes);
                entityCtx.Store.KeepReferenced(contents);
                entityCtx.Store.Prune();
                entityCtx.Store.Save();
                ctx.Result.MeshesMade += entityCtx.Store.Made;
                ctx.Result.Warnings.AddRange(entityCtx.Result.Warnings);
                ctx.Result.EntitiesBuilt++;
                return PrefabUtility.SaveAsPrefabAsset(contents, path);
            }
            finally
            {
                if (existing != null) PrefabUtility.UnloadPrefabContents(contents);
                else UnityEngine.Object.DestroyImmediate(contents);
            }
        }

        /// <summary>Edits, recorded for undo in a Level (one step per sync), or plain inside a prefab being edited.</summary>
        class Edit
        {
            public readonly bool Undoable;
            readonly string name;

            public Edit(bool undoable, string name)
            {
                Undoable = undoable;
                this.name = name;
            }

            public void Record(UnityEngine.Object o)
            {
                if (Undoable) Undo.RecordObject(o, name);
            }

            public T Add<T>(GameObject go) where T : Component => Undoable ? Undo.AddComponent<T>(go) : go.AddComponent<T>();

            public Component Add(GameObject go, Type type) => Undoable ? Undo.AddComponent(go, type) : go.AddComponent(type);

            public void Destroy(UnityEngine.Object o)
            {
                if (Undoable) Undo.DestroyObjectImmediate(o);
                else UnityEngine.Object.DestroyImmediate(o);
            }

            public void SetParent(Transform t, Transform parent)
            {
                if (Undoable) Undo.SetTransformParent(t, parent, name);
                else t.SetParent(parent, true);
            }

            public void Created(GameObject go)
            {
                if (Undoable) Undo.RegisterCreatedObjectUndo(go, name);
            }

            public InteractionMode Mode => Undoable ? InteractionMode.UserAction : InteractionMode.AutomatedAction;
        }

        /// <summary>Brings the objects under one root (a Level, or an entity prefab's contents) in line with records.</summary>
        class Reconciler
        {
            readonly Transform root;
            readonly Context ctx;
            readonly Edit edit;
            // In a Level: claims, drift and orphans count. In a generated prefab, the export is all there is.
            readonly bool level;
            readonly Dictionary<string, OrlaNode> index = new Dictionary<string, OrlaNode>();
            readonly HashSet<OrlaNode> seen = new HashSet<OrlaNode>();
            readonly Dictionary<string, Transform> placed = new Dictionary<string, Transform>();
            readonly HashSet<GameObject> created = new HashSet<GameObject>();
            Result Result => ctx.Result;

            public Reconciler(Transform root, Context ctx, Edit edit, bool level)
            {
                this.root = root;
                this.ctx = ctx;
                this.edit = edit;
                this.level = level;
            }

            public void Run(NodeRecord[] records)
            {
                Index();
                foreach (var r in records) Process(r);
                RemoveUnseen();
            }

            /// <summary>Part of a prefab instance's own contents (not its root, and not something added to it in Unity).</summary>
            static bool IsPrefabContent(GameObject go) =>
                PrefabUtility.IsPartOfPrefabInstance(go) && PrefabUtility.GetOutermostPrefabInstanceRoot(go) != go && !PrefabUtility.IsAddedGameObjectOverride(go);

            static bool IsOrphans(Transform t) => t.name.StartsWith("Orphaned (", StringComparison.Ordinal);

            /// <summary>The synced objects under the root, by ID: not an instance's contents, not what's kept in Orphaned.</summary>
            void Index()
            {
                foreach (var n in root.GetComponentsInChildren<OrlaNode>(true))
                {
                    // (An entity's root under an instance is a mapped instance's kept blockout: part of that instance.)
                    if (n.transform == root || string.IsNullOrEmpty(n.id) || n.type == "entity" || IsPrefabContent(n.gameObject)) continue;
                    if (level && InOrphans(n.transform)) continue;
                    if (index.ContainsKey(n.id))
                    {
                        // A copy made in Unity (it has the same ID): it becomes the user's.
                        edit.Record(n);
                        Result.Warnings.Add($"{n.gameObject.name} is a copy of {n.id} made in Unity: it's yours now, and syncs leave it alone.");
                        n.id = "";
                        continue;
                    }
                    index[n.id] = n;
                }
            }

            bool InOrphans(Transform t)
            {
                for (var p = t; p != null && p != root; p = p.parent)
                    if (p.parent == root && IsOrphans(p)) return true;
                return false;
            }

            /// <summary>Claimed itself, or under something claimed.</summary>
            bool Claimed(OrlaNode n)
            {
                for (var t = n.transform; t != null && t != root; t = t.parent)
                {
                    var o = t.GetComponent<OrlaNode>();
                    if (o != null && o.claimed) return true;
                }
                return false;
            }

            /// <summary>Moved, turned, scaled or reparented in Unity since the last sync set it.</summary>
            bool Drifted(OrlaNode n)
            {
                // Made before syncs kept track (15.3): take orlablocks' version.
                if (string.IsNullOrEmpty(n.rev)) return false;
                var t = n.transform;
                var parentNode = t.parent != null ? t.parent.GetComponent<OrlaNode>() : null;
                var parentId = t.parent == root ? "" : parentNode != null ? parentNode.id : "?";
                if (parentId != n.syncedParent) return true;
                return (t.localPosition - n.syncedPosition).sqrMagnitude > 1e-8f
                    || Quaternion.Angle(t.localRotation, n.syncedRotation) > 0.01f
                    || (t.localScale - n.syncedScale).sqrMagnitude > 1e-8f;
            }

            Transform ParentFor(NodeRecord r) =>
                !string.IsNullOrEmpty(r.parent) && placed.TryGetValue(r.parent, out var p) && p != null ? p : root;

            void Process(NodeRecord r)
            {
                var parent = ParentFor(r);
                if (index.TryGetValue(r.id, out var n) && n != null)
                {
                    seen.Add(n);
                    placed[r.id] = n.transform;
                    if (r.IsPlacement) Result.Instances++;
                    if (level && Claimed(n))
                    {
                        if (n.rev.Split('|')[0] != (r.rev ?? "")) Result.ClaimedChanged.Add(n.gameObject);
                        return;
                    }
                    if (level && !n.revert && Drifted(n))
                    {
                        Result.Moved.Add(n.gameObject);
                        return;
                    }
                    if (n.rev == ctx.Rev(r.rev) && !n.revert && !MissingMesh(n, r))
                    {
                        Result.Unchanged++;
                        return;
                    }
                    // (Replace destroys n: don't touch it after.)
                    var replace = NeedsReplace(n, r);
                    var go = replace ? Replace(n, r, parent) : n.gameObject;
                    if (!replace) Apply(go, r, parent);
                    placed[r.id] = go.transform;
                    Stamp(go, r);
                    Result.Updated++;
                    return;
                }
                var made = Create(r, parent);
                if (r.IsPlacement) Result.Instances++;
                placed[r.id] = made.transform;
                Stamp(made, r);
                Result.Created++;
            }

            static bool MissingMesh(OrlaNode n, NodeRecord r)
            {
                if (!r.IsShape || !r.HasMesh) return false;
                var f = n.GetComponent<MeshFilter>();
                return f == null || f.sharedMesh == null;
            }

            /// <summary>What the next sync compares against: the rev, the parent and the transform this sync set.</summary>
            void Stamp(GameObject go, NodeRecord r)
            {
                var node = go.GetComponent<OrlaNode>();
                edit.Record(node);
                node.rev = ctx.Rev(r.rev);
                node.revert = false;
                node.syncedParent = r.parent ?? "";
                node.syncedPosition = go.transform.localPosition;
                node.syncedRotation = go.transform.localRotation;
                node.syncedScale = go.transform.localScale;
            }

            bool NeedsReplace(OrlaNode n, NodeRecord r)
            {
                var wasPlacement = n.type == "instance" || n.type == "item";
                if (wasPlacement != r.IsPlacement) return true;
                if (!r.IsPlacement) return false;
                // Its entity was swapped: another prefab.
                var prefab = PrefabFor(r, out _);
                return prefab != null && PrefabUtility.GetCorrespondingObjectFromSource(n.gameObject) != prefab;
            }

            GameObject Create(NodeRecord r, Transform parent)
            {
                GameObject go = null;
                if (r.IsPlacement)
                {
                    var prefab = PrefabFor(r, out _);
                    if (prefab != null) go = (GameObject)PrefabUtility.InstantiatePrefab(prefab, parent);
                    else Result.Warnings.Add($"{r.id}: no entity {r.entity} in the export; it's an empty object.");
                }
                if (go == null)
                {
                    go = new GameObject(r.GameObjectName);
                    go.transform.SetParent(parent, false);
                }
                if (!created.Contains(parent.gameObject)) edit.Created(go);
                created.Add(go);
                Apply(go, r, parent);
                return go;
            }

            /// <summary>A node whose kind of object changed (an instance's entity swapped): a new one, with what you added to the old.</summary>
            GameObject Replace(OrlaNode n, NodeRecord r, Transform parent)
            {
                var old = n.gameObject;
                var go = Create(r, parent);
                foreach (var child in old.transform.Cast<Transform>().ToList())
                    if (!IsPrefabContent(child.gameObject) && !IsBlockout(child)) edit.SetParent(child, go.transform);
                var fresh = go.GetComponent<OrlaNode>();
                index[r.id] = fresh;
                seen.Add(fresh);
                edit.Destroy(old);
                return go;
            }

            void Apply(GameObject go, NodeRecord r, Transform parent)
            {
                if (go.transform.parent != parent) edit.SetParent(go.transform, parent);
                edit.Record(go.transform);
                go.transform.localPosition = NodeRecord.V(r.position);
                go.transform.localEulerAngles = NodeRecord.V(r.euler);
                var mapping = r.IsPlacement ? ctx.Mappings.Entity(r.entity) : null;
                var scale = r.scale > 0 ? r.scale : 1f;
                go.transform.localScale = Vector3.one * scale * (mapping != null && mapping.scale > 0 ? mapping.scale : 1f);
                if (mapping != null)
                {
                    // Your prefab offset and turned from the entity's pivot, in the entity's frame (scaled with the instance).
                    var turn = go.transform.localRotation;
                    go.transform.localPosition += turn * (mapping.offset * scale);
                    go.transform.localRotation = turn * Quaternion.Euler(mapping.rotation);
                }
                if (go.name != r.GameObjectName)
                {
                    edit.Record(go);
                    go.name = r.GameObjectName;
                }
                var node = go.GetComponent<OrlaNode>();
                if (node == null) node = edit.Add<OrlaNode>(go);
                edit.Record(node);
                node.id = r.id;
                node.type = r.type;
                node.kind = r.kind ?? "";
                node.color = r.color ?? "";
                node.entity = r.entity ?? "";
                // An instance carries its entity's tags as well as its own.
                var own = r.tags ?? new string[0];
                node.tags = r.IsPlacement && ctx.EntityTags.TryGetValue(r.entity ?? "", out var entityTags) ? entityTags.Union(own).ToArray() : own;
                // An instance keeps its entity's description (the prefab's), unless it has one of its own.
                if (!r.IsPlacement || !string.IsNullOrEmpty(r.description)) node.description = r.description ?? "";
                node.hash = r.hash ?? "";

                if (r.type == "terrain") ApplyTerrain(go, r);
                else if (r.IsShape) ApplyShape(go, r);
                else if (r.type == "note") ApplyNote(go, r);
                else if (r.type == "line") ApplyLine(go, r);
                if (r.IsPlacement)
                {
                    // Cuts go on the generated blockout: the instance itself, or the one kept under a mapped prefab.
                    var blockout = mapping != null ? ApplyBlockout(go, r, mapping) : go;
                    if (blockout != null)
                    {
                        ApplyCuts(blockout, node, r);
                        ApplyColliders(blockout, node, r.noColliders);
                    }
                }
                ApplyRules(go, r);

                var active = !r.hidden;
                if (go.activeSelf != active)
                {
                    edit.Record(go);
                    go.SetActive(active);
                }
            }

            T Ensure<T>(GameObject go) where T : Component
            {
                var c = go.GetComponent<T>();
                return c != null ? c : edit.Add<T>(go);
            }

            void Drop<T>(GameObject go) where T : Component
            {
                var c = go.GetComponent<T>();
                if (c != null) edit.Destroy(c);
            }

            void ApplyTerrain(GameObject go, NodeRecord r)
            {
                if (r.terrain == null) throw new Exception("Terrain record is missing its height payload.");
                var heights = ctx.Bin.Heights(r.terrain);
                Assets.EnsureFolder(ctx.TerrainFolder);
                var path = $"{ctx.TerrainFolder}/{Assets.Safe(r.id)}.asset";
                var data = AssetDatabase.LoadAssetAtPath<TerrainData>(path);
                if (data == null) { data = new TerrainData { name = r.GameObjectName }; AssetDatabase.CreateAsset(data, path); }
                Undo.RegisterCompleteObjectUndo(data, "Sync terrain");
                data.heightmapResolution = r.terrain.resolution;
                data.size = NodeRecord.V(r.terrain.size);
                data.SetHeights(0, 0, heights);
                // Each terrain owns its generated assets: claiming one cannot mutate another through a shared cache.
                var layerPath = $"{ctx.TerrainFolder}/{Assets.Safe(r.id)}-layer.terrainlayer";
                var layer = AssetDatabase.LoadAssetAtPath<TerrainLayer>(layerPath);
                if (layer == null) { layer = new TerrainLayer(); AssetDatabase.CreateAsset(layer, layerPath); }
                var texturePath = $"{ctx.TerrainFolder}/{Assets.Safe(r.id)}-color.asset";
                var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(texturePath);
                if (texture == null) { texture = new Texture2D(2, 2); AssetDatabase.CreateAsset(texture, texturePath); }
                edit.Record(texture); edit.Record(layer);
                var color = ctx.Palette.TryGetValue(r.color ?? "", out var c) ? c : Color.white;
                texture.SetPixels(new[] { color, color, color, color }); texture.Apply();
                layer.diffuseTexture = texture; layer.tileSize = Vector2.one;
                data.terrainLayers = new[] { layer };
                // A single layer defaults to full weight; no painted alphamap is authored in 16.1.
                var terrain = Ensure<Terrain>(go); edit.Record(terrain); terrain.terrainData = data;
                var shader = Shader.Find("Universal Render Pipeline/Terrain/Lit") ?? Shader.Find("Nature/Terrain/Standard");
                if (shader != null) {
                    var matPath = $"{ctx.TerrainFolder}/{Assets.Safe(r.id)}.mat";
                    var material = AssetDatabase.LoadAssetAtPath<Material>(matPath);
                    if (material == null) { material = new Material(shader); AssetDatabase.CreateAsset(material, matPath); }
                    terrain.materialTemplate = material;
                }
                if (r.collider == "terrain") { var collider = Ensure<TerrainCollider>(go); edit.Record(collider); collider.terrainData = data; }
                else Drop<TerrainCollider>(go);
                EditorUtility.SetDirty(data); EditorUtility.SetDirty(layer); EditorUtility.SetDirty(texture);
                terrain.Flush();
            }

            void ApplyShape(GameObject go, NodeRecord r)
            {
                if (!r.HasMesh) return;
                var mesh = ctx.Mesh(r.hash, r.body, r.floor);
                var filter = Ensure<MeshFilter>(go);
                if (filter.sharedMesh != mesh)
                {
                    edit.Record(filter);
                    filter.sharedMesh = mesh;
                }
                // A hole keeps its mesh (for its gizmo) but isn't drawn and has no collider.
                if (r.kind == "hole")
                {
                    Drop<MeshRenderer>(go);
                    Drop<BoxCollider>(go);
                    Drop<MeshCollider>(go);
                    return;
                }
                var renderer = Ensure<MeshRenderer>(go);
                var materials = new List<Material>();
                if (r.body.vertices > 0) materials.Add(ctx.Body(r.color));
                if (r.floor.vertices > 0) materials.Add(ctx.Floor(r.color));
                if (!renderer.sharedMaterials.SequenceEqual(materials))
                {
                    edit.Record(renderer);
                    renderer.sharedMaterials = materials.ToArray();
                }
                if (r.collider == "box")
                {
                    Drop<MeshCollider>(go);
                    var box = Ensure<BoxCollider>(go);
                    var center = NodeRecord.V(r.boxCenter);
                    var size = NodeRecord.V(r.boxSize);
                    if (box.center != center || box.size != size || !box.enabled)
                    {
                        edit.Record(box);
                        box.center = center;
                        box.size = size;
                        box.enabled = true;
                    }
                }
                else if (r.collider == "mesh")
                {
                    Drop<BoxCollider>(go);
                    var mc = Ensure<MeshCollider>(go);
                    if (mc.sharedMesh != mesh)
                    {
                        edit.Record(mc);
                        mc.sharedMesh = mesh;
                    }
                }
                else
                {
                    Drop<BoxCollider>(go);
                    Drop<MeshCollider>(go);
                }
                var flags = GameObjectUtility.GetStaticEditorFlags(go);
                if ((flags & ctx.Flags) != ctx.Flags)
                {
                    edit.Record(go);
                    GameObjectUtility.SetStaticEditorFlags(go, flags | ctx.Flags);
                }
            }

            void ApplyNote(GameObject go, NodeRecord r)
            {
                var note = Ensure<OrlaNote>(go);
                edit.Record(note);
                note.text = r.text ?? "";
                note.label = r.label ?? "";
                note.status = string.IsNullOrEmpty(r.status) ? "open" : r.status;
                if (ctx.Palette.TryGetValue(r.color ?? "", out var c)) note.color = c;
                EditorOnly(go, KeptInBuilds(go));
            }

            void ApplyLine(GameObject go, NodeRecord r)
            {
                var line = Ensure<OrlaLine>(go);
                edit.Record(line);
                var pts = r.points ?? new float[0];
                line.points = new Vector3[pts.Length / 3];
                for (int i = 0; i < line.points.Length; i++) line.points[i] = new Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
                if (ctx.Palette.TryGetValue(r.color ?? "", out var c)) line.color = c;
                line.dashed = r.dashed;
                line.thickness = r.thickness > 0 ? r.thickness : 2f;
                line.arrow = string.IsNullOrEmpty(r.arrow) ? "none" : r.arrow;
                EditorOnly(go, KeptInBuilds(go));
            }

            /// <summary>Notes and lines are EditorOnly, unless a tag they're under keeps them in builds.</summary>
            void EditorOnly(GameObject go, bool kept)
            {
                if (kept == !go.CompareTag("EditorOnly")) return;
                edit.Record(go);
                go.tag = kept ? "Untagged" : "EditorOnly";
            }

            /// <summary>The tags something carries: its own and those of everything it's in (up to the root, whose own count too).</summary>
            IEnumerable<string> Carried(GameObject go)
            {
                for (var t = go.transform; t != null; t = t.parent)
                {
                    var n = t.GetComponent<OrlaNode>();
                    if (n != null && n.tags != null) foreach (var tag in n.tags) yield return tag;
                    if (t == root) yield break;
                }
            }

            bool KeptInBuilds(GameObject go) => ctx.Mappings.HasTagRules && ctx.Mappings.Rules(Carried(go)).Any(rule => rule.keepInBuilds);

            /// <summary>
            /// The tag mappings for what it carries: a layer (on an instance, on its parts too, where its colliders
            /// are), a Unity tag, components (added if missing, never removed) and static flags (added).
            /// </summary>
            void ApplyRules(GameObject go, NodeRecord r)
            {
                if (!ctx.Mappings.HasTagRules) return;
                var rules = ctx.Mappings.Rules(Carried(go));
                if (rules.Count == 0) return;
                var parts = r.IsPlacement ? go.GetComponentsInChildren<Transform>(true).Select(t => t.gameObject).Where(g => g == go || PrefabUtility.IsPartOfPrefabInstance(g)).ToList() : new List<GameObject> { go };
                var noteOrLine = r.type == "note" || r.type == "line";
                foreach (var rule in rules)
                {
                    if (rule.setLayer)
                        foreach (var g in parts)
                            if (g.layer != rule.layer)
                            {
                                edit.Record(g);
                                g.layer = rule.layer;
                            }
                    // A note or line stays EditorOnly unless the tag keeps it in builds.
                    if (!string.IsNullOrEmpty(rule.unityTag) && (!noteOrLine || KeptInBuilds(go)) && !go.CompareTag(rule.unityTag) && ctx.Mappings.TagExists(rule.unityTag))
                    {
                        edit.Record(go);
                        go.tag = rule.unityTag;
                    }
                    foreach (var name in rule.components ?? new List<string>())
                    {
                        var type = ctx.Mappings.Component(name);
                        if (type != null && go.GetComponent(type) == null) edit.Add(go, type);
                    }
                    if (rule.staticFlags != 0)
                        foreach (var g in parts)
                        {
                            var flags = GameObjectUtility.GetStaticEditorFlags(g);
                            var want = flags | (StaticEditorFlags)rule.staticFlags;
                            if (want == flags) continue;
                            edit.Record(g);
                            GameObjectUtility.SetStaticEditorFlags(g, want);
                        }
                }
            }

            /// <summary>The prefab an instance or item places: its entity's mapped prefab, or the generated one.</summary>
            GameObject PrefabFor(NodeRecord r, out OrlaMappings.EntityMapping mapping)
            {
                mapping = ctx.Mappings.Entity(r.entity);
                if (mapping != null) return mapping.prefab;
                return ctx.Prefabs.TryGetValue(r.entity ?? "", out var generated) ? generated : null;
            }

            /// <summary>A mapped instance's kept blockout: the generated prefab under it (its root has the entity's OrlaNode).</summary>
            static bool IsBlockout(Transform t)
            {
                var n = t.GetComponent<OrlaNode>();
                return n != null && n.type == "entity";
            }

            /// <summary>
            /// Under a mapped instance: the generated blockout kept (shown or turned off, at orlablocks' size) or
            /// removed, as the mapping says. Returns the blockout, or null.
            /// </summary>
            GameObject ApplyBlockout(GameObject go, NodeRecord r, OrlaMappings.EntityMapping mapping)
            {
                var existing = go.transform.Cast<Transform>().FirstOrDefault(IsBlockout);
                if (mapping.blockout == OrlaMappings.Blockout.Replace || !ctx.Prefabs.TryGetValue(r.entity ?? "", out var generated) || generated == null)
                {
                    if (existing != null) edit.Destroy(existing.gameObject);
                    return null;
                }
                GameObject blockout;
                if (existing != null) blockout = existing.gameObject;
                else
                {
                    blockout = (GameObject)PrefabUtility.InstantiatePrefab(generated, go.transform);
                    blockout.name = $"blockout ({r.entity})";
                    if (!created.Contains(go)) edit.Created(blockout);
                }
                // Back at the entity's pivot, turn and size: the mapping's offset, turn and scale undone.
                var m = mapping.scale > 0 ? mapping.scale : 1f;
                var undo = Quaternion.Inverse(Quaternion.Euler(mapping.rotation));
                edit.Record(blockout.transform);
                blockout.transform.localPosition = -(undo * mapping.offset) / m;
                blockout.transform.localRotation = undo;
                blockout.transform.localScale = Vector3.one / m;
                var shown = mapping.blockout == OrlaMappings.Blockout.Keep;
                if (blockout.activeSelf != shown)
                {
                    edit.Record(blockout);
                    blockout.SetActive(shown);
                }
                return blockout;
            }

            /// <summary>An instance's cut children: their own meshes, and the prefab's back on the ones no longer cut.</summary>
            void ApplyCuts(GameObject go, OrlaNode node, NodeRecord r)
            {
                var cuts = r.cuts ?? new CutRecord[0];
                var now = cuts.Select(c => c.shape).ToArray();
                var children = go.GetComponentsInChildren<OrlaNode>(true).Where(c => c.gameObject != go && IsPrefabContent(c.gameObject)).ToList();
                foreach (var child in children)
                    if ((node.cutShapes ?? new string[0]).Contains(child.id) && !now.Contains(child.id)) RevertCut(child.gameObject);
                foreach (var cut in cuts)
                {
                    var child = children.FirstOrDefault(c => c.id == cut.shape);
                    if (child == null) continue;
                    var mesh = ctx.Mesh(cut.hash, cut.body, cut.floor);
                    var filter = child.GetComponent<MeshFilter>();
                    if (filter != null && filter.sharedMesh != mesh)
                    {
                        edit.Record(filter);
                        filter.sharedMesh = mesh;
                    }
                    // A box collider no longer fits a cut shape: the mesh's own collider instead. (A prefab
                    // instance's component can't be removed, so the box is turned off.)
                    var box = child.GetComponent<BoxCollider>();
                    if (box != null && box.enabled)
                    {
                        edit.Record(box);
                        box.enabled = false;
                    }
                    var mc = Ensure<MeshCollider>(child.gameObject);
                    if (mc.sharedMesh != mesh)
                    {
                        edit.Record(mc);
                        mc.sharedMesh = mesh;
                    }
                }
                node.cutShapes = now;
            }

            /// <summary>
            /// An instance in something carrying #no-collisions: its entity's colliders off, for this instance only
            /// (and on again when it no longer is). A cut child's box collider stays off either way.
            /// </summary>
            void ApplyColliders(GameObject blockout, OrlaNode node, bool off)
            {
                var cut = node.cutShapes ?? new string[0];
                foreach (var col in blockout.GetComponentsInChildren<Collider>(true))
                {
                    if (!IsPrefabContent(col.gameObject)) continue;
                    var part = col.GetComponent<OrlaNode>();
                    var cutBox = col is BoxCollider && part != null && cut.Contains(part.id);
                    var want = !off && !cutBox;
                    if (col.enabled == want) continue;
                    edit.Record(col);
                    col.enabled = want;
                }
            }

            void RevertCut(GameObject child)
            {
                var filter = child.GetComponent<MeshFilter>();
                if (filter != null) PrefabUtility.RevertObjectOverride(filter, edit.Mode);
                var box = child.GetComponent<BoxCollider>();
                if (box != null) PrefabUtility.RevertObjectOverride(box, edit.Mode);
                var mc = child.GetComponent<MeshCollider>();
                if (mc == null) return;
                if (PrefabUtility.IsAddedComponentOverride(mc)) edit.Destroy(mc);
                else PrefabUtility.RevertObjectOverride(mc, edit.Mode);
            }

            /// <summary>
            /// What orlablocks no longer has. Claimed objects stay (listed). The rest are destroyed, top-most first; in a
            /// Level, what was added to them in Unity (and anything claimed or still synced under them) is moved to
            /// "Orphaned (id)" first, where it was.
            /// </summary>
            void RemoveUnseen()
            {
                var gone = new HashSet<OrlaNode>(index.Values.Where(n => n != null && !seen.Contains(n)));
                foreach (var n in gone.ToList())
                {
                    if (n == null) continue;
                    if (level && Claimed(n))
                    {
                        Result.Gone.Add(n.gameObject);
                        continue;
                    }
                    if (UnderGone(n, gone)) continue;
                    if (level) Rescue(n.transform, n.id, gone);
                    edit.Destroy(n.gameObject);
                    Result.Removed++;
                }
            }

            /// <summary>Under another object that's being removed (it goes with that one).</summary>
            bool UnderGone(OrlaNode n, HashSet<OrlaNode> gone)
            {
                for (var t = n.transform.parent; t != null && t != root; t = t.parent)
                {
                    var o = t.GetComponent<OrlaNode>();
                    if (o != null && gone.Contains(o) && !Claimed(o)) return true;
                }
                return false;
            }

            void Rescue(Transform t, string id, HashSet<OrlaNode> gone)
            {
                foreach (var child in t.Cast<Transform>().ToList())
                {
                    if (IsPrefabContent(child.gameObject) || IsBlockout(child)) continue;
                    var n = child.GetComponent<OrlaNode>();
                    if (n != null && gone.Contains(n) && !Claimed(n))
                    {
                        Rescue(child, id, gone);
                        Result.Removed++;
                        continue;
                    }
                    edit.SetParent(child, Orphans(id));
                    Result.Orphaned++;
                }
            }

            Transform Orphans(string id)
            {
                var name = $"Orphaned ({id})";
                var found = root.Find(name);
                if (found != null) return found;
                var go = new GameObject(name);
                go.transform.SetParent(root, false);
                edit.Created(go);
                return go.transform;
            }
        }
    }
}
