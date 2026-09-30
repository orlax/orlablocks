using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.IMGUI.Controls;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// The mappings' inspector (plan 15 §9): one row per entity, tag and color. The dropdowns offer what the exports
    /// of the Levels using these mappings have (entity names, tags, palette colors); with none open, IDs are typed.
    /// Scripts are picked as scripts and kept by type name. Changes apply on the next sync.
    /// </summary>
    [CustomEditor(typeof(OrlaMappings))]
    public class OrlaMappingsEditor : UnityEditor.Editor
    {
        // What the exports offer: (value, shown).
        List<(string id, string label)> entities = new List<(string, string)>();
        List<(string id, string label)> tags = new List<(string, string)>();
        List<(string id, string label)> colors = new List<(string, string)>();
        double readAt = -1;
        static Dictionary<string, MonoScript> scripts;
        // Filters the entity rows (by entity, name or prefab).
        string entityFilter = "";
        SearchField searchField;

        void Known()
        {
            if (EditorApplication.timeSinceStartup - readAt < 5) return;
            readAt = EditorApplication.timeSinceStartup;
            var e = new Dictionary<string, string>();
            var t = new Dictionary<string, string>();
            var c = new Dictionary<string, string>();
            foreach (var level in UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Include))
            {
                if (level.mappings != target || string.IsNullOrEmpty(level.folder)) continue;
                try
                {
                    var m = Manifest.Read(Assets.FullPath(level.folder));
                    foreach (var x in m.entities) e[x.id] = $"{x.name} ({x.id})";
                    foreach (var x in m.tags) t[x.name] = $"#{x.name}";
                    foreach (var x in m.palette) c[x.key] = x.key;
                }
                catch (Exception)
                {
                    // An unreadable export offers nothing; typing still works.
                }
            }
            entities = e.Select(p => (p.Key, p.Value)).OrderBy(p => p.Value).ToList();
            tags = t.Select(p => (p.Key, p.Value)).OrderBy(p => p.Value).ToList();
            colors = c.Select(p => (p.Key, p.Value)).ToList();
        }

        /// <summary>A dropdown of what's known (and the current value, if it isn't), or a text field when nothing is.</summary>
        static string Pick(string value, List<(string id, string label)> known, string empty, params GUILayoutOption[] options)
        {
            if (known.Count == 0) return EditorGUILayout.TextField(value ?? "", options);
            var items = known.ToList();
            if (!string.IsNullOrEmpty(value) && !items.Any(k => k.id == value)) items.Insert(0, (value, $"{value} (not in the export)"));
            var labels = new[] { empty }.Concat(items.Select(k => k.label)).ToArray();
            var at = string.IsNullOrEmpty(value) ? 0 : items.FindIndex(k => k.id == value) + 1;
            var picked = EditorGUILayout.Popup(at, labels, options);
            return picked == 0 ? "" : items[picked - 1].id;
        }

        /// <summary>
        /// A button showing the value that opens a searchable list of what's known (Unity's AdvancedDropdown): for
        /// a project with a hundred entities. A text field when nothing is known. The pick lands after this GUI pass.
        /// </summary>
        void Search(string value, List<(string id, string label)> known, string empty, Action<string> set)
        {
            if (known.Count == 0)
            {
                var typed = EditorGUILayout.TextField(value ?? "");
                if (typed != (value ?? "")) set(typed);
                return;
            }
            var label = string.IsNullOrEmpty(value) ? empty : known.Where(k => k.id == value).Select(k => k.label).DefaultIfEmpty($"{value} (not in the export)").First();
            var rect = GUILayoutUtility.GetRect(new GUIContent(label), EditorStyles.popup, GUILayout.ExpandWidth(true));
            if (!EditorGUI.DropdownButton(rect, new GUIContent(label), FocusType.Keyboard)) return;
            var target_ = (OrlaMappings)target;
            new SearchList(empty, known, picked =>
            {
                Undo.RecordObject(target_, "Edit mappings");
                set(picked);
                EditorUtility.SetDirty(target_);
                Repaint();
            }).Show(rect);
        }

        class SearchList : AdvancedDropdown
        {
            readonly string title;
            readonly List<(string id, string label)> items;
            readonly Action<string> picked;

            public SearchList(string title, List<(string id, string label)> items, Action<string> picked) : base(new AdvancedDropdownState())
            {
                this.title = title;
                this.items = items;
                this.picked = picked;
                minimumSize = new Vector2(280, 320);
            }

            protected override AdvancedDropdownItem BuildRoot()
            {
                var root = new AdvancedDropdownItem(title);
                foreach (var (id, label) in items) root.AddChild(new Item(label, id));
                return root;
            }

            protected override void ItemSelected(AdvancedDropdownItem item) => picked(((Item)item).Id);

            class Item : AdvancedDropdownItem
            {
                public readonly string Id;
                public Item(string name, string id) : base(name) { Id = id; }
            }
        }

        static bool Matches(string filter, params string[] fields) =>
            string.IsNullOrEmpty(filter) || fields.Any(f => !string.IsNullOrEmpty(f) && f.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0);

        static MonoScript Script(string typeName)
        {
            if (string.IsNullOrEmpty(typeName)) return null;
            if (scripts == null)
            {
                scripts = new Dictionary<string, MonoScript>();
                foreach (var s in MonoImporter.GetAllRuntimeMonoScripts())
                {
                    var cls = s.GetClass();
                    if (cls != null && cls.AssemblyQualifiedName != null) scripts[cls.AssemblyQualifiedName] = s;
                }
            }
            return scripts.TryGetValue(typeName, out var found) ? found : null;
        }

        public override void OnInspectorGUI()
        {
            var m = (OrlaMappings)target;
            Known();
            EditorGUILayout.HelpBox("Applied on the next sync of every Level that uses these mappings. A project's entity prefabs are shared by its Levels, so give them the same mappings.", MessageType.None);
            EditorGUI.BeginChangeCheck();
            Undo.RecordObject(m, "Edit mappings");

            Section("Entities", "An entity's instances and array items as your prefab.", () =>
            {
                m.entities.Add(new OrlaMappings.EntityMapping());
                entityFilter = "";
            });
            if (m.entities.Count > 5) entityFilter = (searchField ??= new SearchField()).OnGUI(entityFilter);
            for (int i = 0; i < m.entities.Count; i++)
            {
                var e = m.entities[i];
                var name = entities.Where(k => k.id == e.entity).Select(k => k.label).FirstOrDefault();
                if (!Matches(entityFilter, e.entity, name, e.prefab != null ? e.prefab.name : null)) continue;
                using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
                {
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        var row = e;
                        Search(e.entity, entities, "Entity…", picked => row.entity = picked);
                        if (Remove()) { m.entities.RemoveAt(i--); continue; }
                    }
                    e.prefab = (GameObject)EditorGUILayout.ObjectField("Prefab", e.prefab, typeof(GameObject), false);
                    e.scale = EditorGUILayout.FloatField(new GUIContent("Scale", "Your prefab's scale, times the instance's"), e.scale);
                    e.offset = EditorGUILayout.Vector3Field(new GUIContent("Position offset", "Where your prefab sits from the entity's pivot, in meters in the entity's frame (it grows with the instance's scale)"), e.offset);
                    e.rotation = EditorGUILayout.Vector3Field(new GUIContent("Rotation offset", "Your prefab turned from the entity's orientation, in degrees"), e.rotation);
                    e.blockout = (OrlaMappings.Blockout)EditorGUILayout.EnumPopup(new GUIContent("Blockout", "Replace: only your prefab. Keep hidden: the blockout under it, turned off. Keep: shown."), e.blockout);
                }
            }

            Section("Tags", "What carries a tag (and everything in a tagged group).", () => m.tags.Add(new OrlaMappings.TagMapping()));
            for (int i = 0; i < m.tags.Count; i++)
            {
                var t = m.tags[i];
                using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
                {
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        var row = t;
                        Search(t.tag, tags, "Tag…", picked => row.tag = picked);
                        if (Remove()) { m.tags.RemoveAt(i--); continue; }
                    }
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        t.setLayer = EditorGUILayout.ToggleLeft("Layer", t.setLayer, GUILayout.Width(60));
                        using (new EditorGUI.DisabledScope(!t.setLayer)) t.layer = EditorGUILayout.LayerField(t.layer);
                    }
                    var none = string.IsNullOrEmpty(t.unityTag);
                    var tag = EditorGUILayout.TagField("Unity tag", none ? "Untagged" : t.unityTag);
                    t.unityTag = tag == "Untagged" ? "" : tag;
                    t.staticFlags = (int)(StaticEditorFlags)EditorGUILayout.EnumFlagsField("Static flags", (StaticEditorFlags)t.staticFlags);
                    t.keepInBuilds = EditorGUILayout.ToggleLeft(new GUIContent("Keep notes and lines in builds", "A route the game reads, say: they're EditorOnly otherwise"), t.keepInBuilds);
                    EditorGUILayout.LabelField("Components (added if missing, never removed)", EditorStyles.miniLabel);
                    for (int k = 0; k < t.components.Count; k++)
                        using (new EditorGUILayout.HorizontalScope())
                        {
                            var current = Script(t.components[k]);
                            var picked = (MonoScript)EditorGUILayout.ObjectField(current, typeof(MonoScript), false);
                            if (picked != current) t.components[k] = picked != null && picked.GetClass() != null ? picked.GetClass().AssemblyQualifiedName : "";
                            if (current == null && !string.IsNullOrEmpty(t.components[k])) EditorGUILayout.LabelField($"missing: {t.components[k].Split(',')[0]}", EditorStyles.miniLabel, GUILayout.Width(140));
                            if (Remove()) t.components.RemoveAt(k--);
                        }
                    if (GUILayout.Button("+ Component", EditorStyles.miniButton, GUILayout.Width(100))) t.components.Add("");
                }
            }

            Section("Colors", "A palette color as your materials, instead of the generated orla-* ones.", () => m.colors.Add(new OrlaMappings.ColorMapping()));
            for (int i = 0; i < m.colors.Count; i++)
            {
                var c = m.colors[i];
                using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
                {
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        c.color = Pick(c.color, colors, "Color…");
                        if (Remove()) { m.colors.RemoveAt(i--); continue; }
                    }
                    c.body = (Material)EditorGUILayout.ObjectField("Body", c.body, typeof(Material), false);
                    c.floor = (Material)EditorGUILayout.ObjectField(new GUIContent("Floor", "A room's floor; empty: the body's"), c.floor, typeof(Material), false);
                }
            }

            if (EditorGUI.EndChangeCheck()) EditorUtility.SetDirty(m);
        }

        static void Section(string title, string help, Action add)
        {
            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.LabelField(title, EditorStyles.boldLabel);
                if (GUILayout.Button("+ Add", EditorStyles.miniButton, GUILayout.Width(60))) add();
            }
            EditorGUILayout.LabelField(help, EditorStyles.wordWrappedMiniLabel);
        }

        static bool Remove() => GUILayout.Button("✕", EditorStyles.miniButton, GUILayout.Width(22));
    }
}
