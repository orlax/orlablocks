using System;
using System.Collections.Generic;
using System.Linq;
using Orlablocks;
using UnityEditor;
using UnityEngine;

namespace OrlablocksPrototype
{
    // Deliberately fixture-only. Production catalog, tags/colors and entry points belong to 18.2.
    public class MappingBrowserPrototype : EditorWindow
    {
        public OrlaMappings mappings;
        public GameObject blockout;
        public string[] knownIds = Array.Empty<string>();
        public string[] knownNames = Array.Empty<string>();
        string search = "", filter = "All", selected = "npc_002";
        Vector2 scroll, detailsScroll;
        readonly Dictionary<GameObject, Texture> previews = new Dictionary<GameObject, Texture>();
        double previewDeadline;
        bool awaitingPreview;
        public int VisibleCards { get; private set; }
        public double LastLayoutMs { get; private set; }
        public List<string> Catalog() => knownIds.Concat(mappings != null ? mappings.entities.Select(e => e.entity) : Enumerable.Empty<string>()).Distinct().ToList();
        public string Label(string id) { int i = Array.IndexOf(knownIds, id); return i >= 0 && i < knownNames.Length ? knownNames[i] : id; }
        OrlaMappings.EntityMapping Rule(string id) => mappings.entities.FirstOrDefault(e => e.entity == id);
        public string Status(string id)
        {
            var rules = mappings.entities.Where(e => e.entity == id).ToList();
            if (rules.Count > 1) return "Invalid: duplicate rules";
            if (rules.Count > 0 && rules[0].prefab == null) return "Invalid: missing prefab";
            if (!knownIds.Contains(id)) return "Not in available exports";
            return rules.Count == 0 ? "Unmapped" : "Mapped";
        }
        string PrefabName(string id) { var rule = Rule(id); return rule != null && rule.prefab != null ? rule.prefab.name : ""; }
        public List<string> Filtered() => Catalog().Where(id =>
            (filter == "All" || Status(id).StartsWith(filter, StringComparison.Ordinal)) &&
            (Label(id) + " " + id + " " + PrefabName(id)).IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
        void OnEnable() { titleContent = new GUIContent("Mappings · prototype"); minSize = new Vector2(340, 400); EditorApplication.projectChanged += Invalidate; Undo.undoRedoPerformed += Repaint; }
        void OnDisable() { EditorApplication.projectChanged -= Invalidate; Undo.undoRedoPerformed -= Repaint; }
        void Invalidate() { previews.Clear(); previewDeadline = 0; Repaint(); }
        void OnInspectorUpdate() { if (awaitingPreview && EditorApplication.timeSinceStartup < previewDeadline) Repaint(); }
        void OnGUI()
        {
            var timer = System.Diagnostics.Stopwatch.StartNew();
            if (mappings == null) { EditorGUILayout.HelpBox("Open the phase 18.1 scratch fixture to view this prototype.", MessageType.Info); return; }
            EditorGUILayout.LabelField("Unity mappings", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("18.1 prototype · entity fixture catalog. Mapping edits apply on the next Sync. Opening this window never syncs a Level.", MessageType.None);
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                search = GUILayout.TextField(search, GUI.skin.FindStyle("ToolbarSearchTextField") ?? EditorStyles.textField);
                string[] filters = { "All", "Mapped", "Unmapped", "Invalid", "Not in available exports" };
                filter = filters[EditorGUILayout.Popup(Array.IndexOf(filters, filter), filters, GUILayout.Width(Mathf.Min(180, position.width * .4f)))];
            }
            EditorGUILayout.LabelField($"Entities ({Filtered().Count})    ·    Tags / Colors follow in 18.2", EditorStyles.miniLabel);
            bool wide = position.width >= 760;
            if (wide)
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    using (new EditorGUILayout.VerticalScope(GUILayout.Width(position.width - 315))) Grid(position.width - 325, position.height - 115);
                    using (new EditorGUILayout.VerticalScope(GUILayout.Width(295))) Details();
                }
            }
            else
            {
                Grid(position.width - 15, Mathf.Max(155, position.height * .43f));
                detailsScroll = EditorGUILayout.BeginScrollView(detailsScroll); Details(); EditorGUILayout.EndScrollView();
            }
            timer.Stop(); LastLayoutMs = timer.Elapsed.TotalMilliseconds;
        }
        void Grid(float width, float height)
        {
            var entries = Filtered();
            int columns = Mathf.Max(1, Mathf.FloorToInt((width - 16) / 190));
            float cardWidth = (width - 16) / columns, rowHeight = 191;
            var viewport = GUILayoutUtility.GetRect(width, height);
            scroll = GUI.BeginScrollView(viewport, scroll, new Rect(0, 0, width - 16, Mathf.Ceil(entries.Count / (float)columns) * rowHeight));
            int first = Mathf.Max(0, Mathf.FloorToInt(scroll.y / rowHeight) * columns);
            int last = Mathf.Min(entries.Count, (Mathf.CeilToInt((scroll.y + height) / rowHeight)) * columns);
            VisibleCards = last - first; awaitingPreview = false;
            for (int i = first; i < last; i++)
            {
                var id = entries[i]; var r = Rule(id);
                Rect card = new Rect(i % columns * cardWidth + 3, i / columns * rowHeight + 3, cardWidth - 6, rowHeight - 6);
                GUI.Box(card, GUIContent.none, selected == id ? GUI.skin.window : EditorStyles.helpBox);
                if (GUI.Button(new Rect(card.x + 5, card.y + 5, card.width - 10, 21), Label(id), EditorStyles.boldLabel)) { selected = id; Repaint(); }
                GUI.Label(new Rect(card.x + 5, card.y + 27, card.width - 10, 18), id, EditorStyles.miniLabel);
                float half = (card.width - 14) / 2;
                Preview(new Rect(card.x + 5, card.y + 48, half, 66), blockout, "Blockout");
                Preview(new Rect(card.x + 9 + half, card.y + 48, half, 66), r?.prefab, "Unity prefab");
                GUI.Label(new Rect(card.x + 5, card.y + 133, card.width - 10, 20), r?.prefab != null ? r.prefab.name : "No prefab assigned", EditorStyles.miniLabel);
                GUI.Label(new Rect(card.x + 5, card.y + 157, card.width - 10, 20), Status(id), EditorStyles.miniLabel);
            }
            GUI.EndScrollView();
        }
        void Preview(Rect rect, GameObject asset, string label)
        {
            Texture texture = null;
            if (asset != null && !previews.TryGetValue(asset, out texture))
            {
                texture = AssetPreview.GetAssetPreview(asset);
                if (texture != null) previews[asset] = texture;
                else
                {
                    if (previewDeadline == 0) previewDeadline = EditorApplication.timeSinceStartup + 2;
                    awaitingPreview |= AssetPreview.IsLoadingAssetPreview(asset.GetEntityId());
                    texture = AssetPreview.GetMiniThumbnail(asset);
                }
            }
            if (texture != null) GUI.DrawTexture(rect, texture, ScaleMode.ScaleToFit);
            else GUI.Label(rect, "◇  No preview", EditorStyles.centeredGreyMiniLabel);
            GUI.Label(new Rect(rect.x, rect.yMax, rect.width, 18), label, EditorStyles.centeredGreyMiniLabel);
        }
        void Details()
        {
            EditorGUILayout.LabelField(Label(selected), EditorStyles.boldLabel);
            EditorGUILayout.LabelField(selected, EditorStyles.miniLabel);
            EditorGUILayout.LabelField(Status(selected), EditorStyles.wordWrappedMiniLabel);
            int index = mappings.entities.FindIndex(e => e.entity == selected);
            if (index < 0) { EditorGUILayout.HelpBox("No saved rule. Selecting an entity creates nothing.", MessageType.None); return; }
            if (mappings.entities.Count(e => e.entity == selected) > 1) { EditorGUILayout.HelpBox("Duplicate rules retained. Resolve explicitly in the existing inspector.", MessageType.Warning); return; }
            var so = new SerializedObject(mappings); so.Update();
            var row = so.FindProperty("entities").GetArrayElementAtIndex(index);
            foreach (string field in new[] { "prefab", "scale", "offset", "rotation", "blockout" }) EditorGUILayout.PropertyField(row.FindPropertyRelative(field));
            so.ApplyModifiedProperties();
            if (Rule(selected)?.prefab != null && GUILayout.Button("Ping prefab")) EditorGUIUtility.PingObject(Rule(selected).prefab);
            EditorGUILayout.Space();
            EditorGUILayout.HelpBox("Recognize an entry in the grid; edit one mapping here. At narrow widths these details move below the grid.", MessageType.None);
        }
    }
}
