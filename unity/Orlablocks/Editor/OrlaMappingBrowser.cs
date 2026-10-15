using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>Dockable, virtualized mapping browser. Only visible cards request asset previews.</summary>
    public class OrlaMappingBrowser : EditorWindow
    {
        [SerializeField] OrlaMappings mappings;
        [SerializeField] int tab, filter;
        [SerializeField] string search = "", selected = "";
        string manual = "";
        Vector2 scroll, detailScroll, sourceScroll;
        bool showSources;
        MappingCatalog catalog;
        bool catalogDirty = true, awaitingPreview;
        double previewDeadline;
        readonly Dictionary<UnityEngine.Object, Texture> previews = new Dictionary<UnityEngine.Object, Texture>();
        readonly HashSet<UnityEngine.Object> requested = new HashSet<UnityEngine.Object>();
        static Dictionary<string, MonoScript> scripts;
        static readonly string[] Filters = { "All", "Mapped", "Unmapped", "Invalid", "Not in available exports" };
        public int VisibleCards { get; private set; }
        public int PreviewRequests => requested.Count;
        public double LastDrawMs { get; private set; }
        public int DrawCount { get; private set; }
        public static OrlaMappingBrowser Open(OrlaMappings asset)
        {
            var window = GetWindow<OrlaMappingBrowser>("Orlablocks mappings");
            window.mappings = asset; window.Invalidate(); window.Show(); return window;
        }
        [MenuItem("Window/Orlablocks/Mapping browser")]
        static void OpenMenu() => Open(Selection.activeObject as OrlaMappings);
        void OnEnable()
        {
            minSize = new Vector2(340, 480);
            EditorApplication.projectChanged += Invalidate;
            EditorApplication.hierarchyChanged += MarkCatalog;
            Undo.undoRedoPerformed += Invalidate;
            catalogDirty = true;
        }
        void OnDisable()
        {
            EditorApplication.projectChanged -= Invalidate;
            EditorApplication.hierarchyChanged -= MarkCatalog;
            Undo.undoRedoPerformed -= Invalidate;
        }
        void MarkCatalog() { catalogDirty = true; Repaint(); }
        void Invalidate() { scripts = null; previews.Clear(); requested.Clear(); previewDeadline = 0; MarkCatalog(); }
        void OnFocus() => MarkCatalog();
        void OnInspectorUpdate() { if (awaitingPreview && EditorApplication.timeSinceStartup < previewDeadline) Repaint(); }
        void OnGUI()
        {
            var timer = System.Diagnostics.Stopwatch.StartNew();
            EditorGUI.BeginChangeCheck();
            mappings = (OrlaMappings)EditorGUILayout.ObjectField("Mappings", mappings, typeof(OrlaMappings), false);
            if (EditorGUI.EndChangeCheck()) { selected = ""; Invalidate(); }
            if (mappings == null) { EditorGUILayout.HelpBox("Choose a mappings asset, or open this browser from a Level or mappings inspector.", MessageType.Info); return; }
            if (catalogDirty || catalog == null) { catalog = MappingCatalog.Read(mappings); catalogDirty = false; }
            EditorGUILayout.LabelField("Changes apply on the next Sync. Opening or editing this browser does not sync Levels.", EditorStyles.wordWrappedMiniLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.LabelField($"Catalog: {catalog.levels} loaded Levels · {catalog.readable} readable exports", EditorStyles.miniLabel);
                if (GUILayout.Button("Refresh", GUILayout.Width(65))) MarkCatalog();
            }
            if (catalog.warnings.Count > 0)
            {
                showSources = EditorGUILayout.Foldout(showSources, $"{catalog.warnings.Count} unreadable sources (rules retained)", true);
                if (showSources)
                {
                    sourceScroll = EditorGUILayout.BeginScrollView(sourceScroll, GUILayout.Height(90));
                    EditorGUILayout.HelpBox(string.Join("\n", catalog.warnings), MessageType.Warning);
                    EditorGUILayout.EndScrollView();
                }
            }
            if (catalog.levels == 0) EditorGUILayout.HelpBox("No loaded Levels use this asset. Saved rules remain editable; add a manual ID below.", MessageType.None);
            EditorGUILayout.LabelField("Not in available exports means outside this catalog, not deleted.", EditorStyles.wordWrappedMiniLabel);
            int next = GUILayout.Toolbar(tab, new[] { "Entities", "Tags", "Colors" });
            if (next != tab) { tab = next; selected = ""; scroll = detailScroll = Vector2.zero; search = ""; }
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                search = GUILayout.TextField(search, GUI.skin.FindStyle("ToolbarSearchTextField") ?? EditorStyles.textField);
                if (tab == 0) filter = EditorGUILayout.Popup(filter, Filters, GUILayout.Width(Mathf.Min(180, position.width * .4f)));
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                manual = EditorGUILayout.TextField(new GUIContent("Manual " + (tab == 0 ? "entity ID" : tab == 1 ? "tag" : "color key")), manual);
                using (new EditorGUI.DisabledScope(string.IsNullOrWhiteSpace(manual)))
                    if (GUILayout.Button("Add rule", GUILayout.Width(70))) { selected = manual.Trim(); AddRule(selected); manual = ""; }
            }
            bool wide = position.width >= 800;
            // Layout allocates the remaining space, including variable-height catalog warnings.
            using (new EditorGUILayout.VerticalScope(GUILayout.ExpandHeight(true)))
            {
                if (wide)
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        using (new EditorGUILayout.VerticalScope(GUILayout.Width(position.width - 330))) Grid(position.width - 340, 0);
                        using (new EditorGUILayout.VerticalScope(GUILayout.Width(310))) DetailPane();
                    }
                else { Grid(position.width - 15, Mathf.Max(150, position.height * .32f)); DetailPane(); }
            }
            if (awaitingPreview && previewDeadline == 0) previewDeadline = EditorApplication.timeSinceStartup + 2;
            LastDrawMs = timer.Elapsed.TotalMilliseconds; DrawCount++;
        }
        List<string> Entries()
        {
            if (tab == 0) return catalog.Filter(mappings, search, filter);
            IEnumerable<string> ids = tab == 1 ? catalog.tags.Concat(mappings.tags.Select(t => t.tag ?? "")) : catalog.colors.Keys.Concat(mappings.colors.Select(c => c.color ?? ""));
            return ids.Distinct().Where(id => string.IsNullOrEmpty(search) || (id + " " + Summary(id)).IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0).OrderBy(id => id).ToList();
        }
        string Summary(string id)
        {
            if (tab == 1)
            {
                var rows = mappings.tags.Where(t => (t.tag ?? "") == id).ToList();
                if (rows.Count == 0) return "Unmapped";
                return string.Join(" · ", rows.Select(t => $"{(t.setLayer ? "Layer " + t.layer + "; " : "")}{t.unityTag} · {t.components.Count} components · flags {t.staticFlags}{(t.keepInBuilds ? " · keep in builds" : "")}"));
            }
            var c = mappings.colors.FirstOrDefault(r => (r.color ?? "") == id);
            return c == null ? "Unmapped" : $"{(c.body != null ? c.body.name : "Generated body")} · {(c.floor != null ? c.floor.name : "Body floor fallback")}";
        }
        void Grid(float width, float height)
        {
            var ids = Entries();
            EditorGUILayout.LabelField($"{ids.Count} entries", EditorStyles.miniLabel);
            int columns = tab == 1 ? 1 : Mathf.Max(1, Mathf.FloorToInt((width - 16) / 195));
            float cardWidth = Mathf.Max(100, (width - 16) / columns), rowHeight = tab == 1 ? 78 : 196;
            Rect viewport = height > 0 ? GUILayoutUtility.GetRect(width, height) : GUILayoutUtility.GetRect(width, 150, GUILayout.ExpandHeight(true));
            scroll = GUI.BeginScrollView(viewport, scroll, new Rect(0, 0, width - 16, Mathf.Ceil(ids.Count / (float)columns) * rowHeight));
            int first = Mathf.Max(0, Mathf.FloorToInt(scroll.y / rowHeight) * columns);
            int last = Mathf.Min(ids.Count, Mathf.CeilToInt((scroll.y + viewport.height) / rowHeight) * columns);
            VisibleCards = Mathf.Max(0, last - first); awaitingPreview = false;
            for (int i = first; i < last; i++)
            {
                string id = ids[i];
                Rect r = new Rect(i % columns * cardWidth + 3, i / columns * rowHeight + 3, cardWidth - 6, rowHeight - 6);
                if (GUI.Button(r, GUIContent.none, selected == id ? GUI.skin.window : EditorStyles.helpBox)) { selected = id; detailScroll = Vector2.zero; }
                if (GUI.Button(new Rect(r.x + 5, r.y + 4, r.width - 10, 22), new GUIContent(tab == 0 ? catalog.Name(id) : id, id), EditorStyles.boldLabel)) { selected = id; detailScroll = Vector2.zero; }
                if (tab == 1) GUI.Label(new Rect(r.x + 5, r.y + 28, r.width - 10, 42), Summary(id), EditorStyles.wordWrappedMiniLabel);
                else if (tab == 0)
                {
                    GUI.Label(new Rect(r.x + 5, r.y + 27, r.width - 10, 18), id, EditorStyles.miniLabel);
                    var rule = mappings.entities.FirstOrDefault(e => (e.entity ?? "") == id);
                    float half = (r.width - 16) / 2;
                    Preview(new Rect(r.x + 5, r.y + 48, half, 64), catalog.entities.TryGetValue(id, out var e) ? e.blockout : null, "Blockout");
                    Preview(new Rect(r.x + 10 + half, r.y + 48, half, 64), rule?.prefab, "Unity prefab");
                    GUI.Label(new Rect(r.x + 5, r.y + 132, r.width - 10, 18), rule != null && rule.prefab != null ? rule.prefab.name : "No prefab assigned", EditorStyles.miniLabel);
                    GUI.Label(new Rect(r.x + 5, r.y + 153, r.width - 10, 18), catalog.Status(mappings, id), EditorStyles.miniLabel);
                    if (!catalog.entities.ContainsKey(id)) GUI.Label(new Rect(r.x + 5, r.y + 171, r.width - 10, 16), "Not in available exports", EditorStyles.miniLabel);
                }
                else
                {
                    if (catalog.colors.TryGetValue(id, out var color)) EditorGUI.DrawRect(new Rect(r.x + 5, r.y + 30, r.width - 10, 16), color);
                    var rule = mappings.colors.FirstOrDefault(c => (c.color ?? "") == id);
                    float half = (r.width - 16) / 2;
                    Preview(new Rect(r.x + 5, r.y + 53, half, 64), rule?.body, "Body material");
                    Preview(new Rect(r.x + 10 + half, r.y + 53, half, 64), rule?.floor, "Floor material");
                    GUI.Label(new Rect(r.x + 5, r.y + 140, r.width - 10, 44), Summary(id), EditorStyles.wordWrappedMiniLabel);
                }
            }
            GUI.EndScrollView();
        }
        void Preview(Rect rect, UnityEngine.Object asset, string label)
        {
            Texture texture = null;
            if (asset != null)
            {
                var id = asset.GetEntityId();
                if (!previews.TryGetValue(asset, out texture))
                {
                    if (requested.Add(asset)) previewDeadline = EditorApplication.timeSinceStartup + 2;
                    if (EditorApplication.timeSinceStartup < previewDeadline)
                    {
                        texture = AssetPreview.GetAssetPreview(asset);
                        awaitingPreview |= texture == null && AssetPreview.IsLoadingAssetPreview(id);
                    }
                    if (texture != null) previews[asset] = texture;
                    else texture = AssetPreview.GetMiniThumbnail(asset);
                }
            }
            if (texture != null) GUI.DrawTexture(rect, texture, ScaleMode.ScaleToFit);
            else { GUI.Label(new Rect(rect.x, rect.y, rect.width, 32), EditorGUIUtility.IconContent("Prefab Icon"), EditorStyles.centeredGreyMiniLabel); GUI.Label(new Rect(rect.x, rect.y + 34, rect.width, 25), "No preview", EditorStyles.centeredGreyMiniLabel); }
            GUI.Label(new Rect(rect.x, rect.yMax, rect.width, 18), label, EditorStyles.centeredGreyMiniLabel);
        }
        void Edit(Action change)
        {
            Undo.RecordObject(mappings, "Edit mappings"); change(); EditorUtility.SetDirty(mappings); Repaint();
        }
        void AddRule(string id)
        {
            if (tab == 1) { id = id.TrimStart('#'); selected = id; }
            Edit(() => { if (tab == 0) mappings.entities.Add(new OrlaMappings.EntityMapping { entity = id });
                else if (tab == 1) mappings.tags.Add(new OrlaMappings.TagMapping { tag = id.TrimStart('#') });
                else mappings.colors.Add(new OrlaMappings.ColorMapping { color = id }); });
        }
        void DetailPane()
        {
            detailScroll = EditorGUILayout.BeginScrollView(detailScroll);
            Details();
            EditorGUILayout.EndScrollView();
        }
        void Details()
        {
            if (selected == "" && !Entries().Contains("")) { EditorGUILayout.HelpBox("Select an entry to edit its mapping.", MessageType.None); return; }
            EditorGUILayout.LabelField(tab == 0 ? catalog.Name(selected) : selected, EditorStyles.boldLabel);
            if (tab == 0) EditorGUILayout.SelectableLabel(selected, EditorStyles.miniLabel, GUILayout.Height(18));
            if (tab == 0 && !catalog.entities.ContainsKey(selected) || tab == 1 && !catalog.tags.Contains(selected) || tab == 2 && !catalog.colors.ContainsKey(selected))
                EditorGUILayout.HelpBox("Not in available exports. The saved rule is retained.", MessageType.None);
            var so = new SerializedObject(mappings); so.Update();
            var array = so.FindProperty(tab == 0 ? "entities" : tab == 1 ? "tags" : "colors");
            string key = tab == 0 ? "entity" : tab == 1 ? "tag" : "color";
            var indices = Enumerable.Range(0, array.arraySize).Where(i => array.GetArrayElementAtIndex(i).FindPropertyRelative(key).stringValue == selected).ToList();
            if (indices.Count == 0)
            {
                EditorGUILayout.HelpBox("No saved rule. Selection creates nothing.", MessageType.None);
                if (tab == 0)
                {
                    var prefab = (GameObject)EditorGUILayout.ObjectField("Prefab", null, typeof(GameObject), false);
                    if (MappingCatalog.ValidPrefab(prefab)) Edit(() => mappings.entities.Add(new OrlaMappings.EntityMapping { entity = selected, prefab = prefab }));
                }
                else if (GUILayout.Button("Create mapping")) AddRule(selected);
                return;
            }
            if (indices.Count > 1) EditorGUILayout.HelpBox(tab == 1 ? "Multiple tag rules are additive; each is preserved." : "Duplicate rules retained. Edit IDs or remove individual rules to resolve explicitly. Existing sync resolution is unchanged.", MessageType.Warning);
            string renamed = null;
            foreach (int index in indices)
            {
                var row = array.GetArrayElementAtIndex(index);
                using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
                {
                    EditorGUILayout.LabelField("Rule " + (index + 1), EditorStyles.miniLabel);
                    EditorGUI.BeginChangeCheck();
                    EditorGUILayout.PropertyField(row.FindPropertyRelative(key), new GUIContent(tab == 0 ? "Entity ID" : tab == 1 ? "Source tag" : "Palette key"));
                    if (EditorGUI.EndChangeCheck()) renamed = row.FindPropertyRelative(key).stringValue;
                    if (tab == 0) EntityDetails(row);
                    else if (tab == 1) TagDetails(row);
                    else { EditorGUILayout.PropertyField(row.FindPropertyRelative("body")); EditorGUILayout.PropertyField(row.FindPropertyRelative("floor")); }
                    if (GUILayout.Button("Remove mapping"))
                    {
                        so.ApplyModifiedProperties();
                        Edit(() => { if (tab == 0) mappings.entities.RemoveAt(index); else if (tab == 1) mappings.tags.RemoveAt(index); else mappings.colors.RemoveAt(index); });
                        return;
                    }
                }
            }
            so.ApplyModifiedProperties();
            if (renamed != null) selected = renamed;
        }
        void EntityDetails(SerializedProperty row)
        {
            var p = row.FindPropertyRelative("prefab");
            EditorGUILayout.PropertyField(p);
            var prefab = p.objectReferenceValue as GameObject;
            if (!MappingCatalog.ValidPrefab(prefab)) EditorGUILayout.HelpBox("Assign a prefab asset. Without one the generated blockout stays.", MessageType.Warning);
            if (prefab != null && GUILayout.Button("Ping prefab")) EditorGUIUtility.PingObject(prefab);
            foreach (var field in new[] { "scale", "offset", "rotation", "blockout" }) EditorGUILayout.PropertyField(row.FindPropertyRelative(field));
        }
        static void TagDetails(SerializedProperty row)
        {
            var setLayer = row.FindPropertyRelative("setLayer"); EditorGUILayout.PropertyField(setLayer);
            using (new EditorGUI.DisabledScope(!setLayer.boolValue)) row.FindPropertyRelative("layer").intValue = EditorGUILayout.LayerField("Layer", row.FindPropertyRelative("layer").intValue);
            // Keep unknown Unity tags editable instead of silently resetting them through TagField.
            var tag = row.FindPropertyRelative("unityTag"); EditorGUILayout.PropertyField(tag, new GUIContent("Unity tag"));
            if (!string.IsNullOrEmpty(tag.stringValue) && !UnityEditorInternal.InternalEditorUtility.tags.Contains(tag.stringValue)) EditorGUILayout.HelpBox("Unity tag does not exist in Tags and Layers.", MessageType.Warning);
            var flags = row.FindPropertyRelative("staticFlags"); flags.intValue = (int)(StaticEditorFlags)EditorGUILayout.EnumFlagsField("Static flags", (StaticEditorFlags)flags.intValue);
            EditorGUILayout.PropertyField(row.FindPropertyRelative("keepInBuilds"));
            EditorGUILayout.LabelField("Components (added if missing)", EditorStyles.miniLabel);
            var components = row.FindPropertyRelative("components");
            for (int i = 0; i < components.arraySize; i++)
            {
                var value = components.GetArrayElementAtIndex(i);
                Type type = null;
                try { type = Type.GetType(value.stringValue); } catch (Exception) { /* Preserve malformed legacy type names for repair. */ }
                if (scripts == null)
                {
                    scripts = new Dictionary<string, MonoScript>();
                    foreach (var script in MonoImporter.GetAllRuntimeMonoScripts())
                    {
                        var cls = script.GetClass();
                        if (cls?.AssemblyQualifiedName != null) scripts[cls.AssemblyQualifiedName] = script;
                    }
                }
                MonoScript current = null;
                if (type != null) scripts.TryGetValue(type.AssemblyQualifiedName, out current);
                using (new EditorGUILayout.HorizontalScope())
                {
                    var picked = (MonoScript)EditorGUILayout.ObjectField(current, typeof(MonoScript), false);
                    if (picked != current)
                    {
                        var cls = picked != null ? picked.GetClass() : null;
                        if (picked == null || cls != null && typeof(Component).IsAssignableFrom(cls) && !cls.IsAbstract) value.stringValue = cls?.AssemblyQualifiedName ?? "";
                    }
                    if (GUILayout.Button("Remove", GUILayout.Width(65))) { components.DeleteArrayElementAtIndex(i); break; }
                }
                if (current == null) EditorGUILayout.PropertyField(value, new GUIContent("Type name"));
            }
            if (GUILayout.Button("Add component")) { components.InsertArrayElementAtIndex(components.arraySize); components.GetArrayElementAtIndex(components.arraySize - 1).stringValue = ""; }
        }
    }
}
