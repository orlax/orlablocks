using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>A snapshot of readable exports of loaded scene Levels. Refresh explicitly or on editor changes;
    /// never read manifests while drawing cards. Absence from this scope never means deletion.</summary>
    public sealed class MappingCatalog
    {
        public sealed class Entity
        {
            public string id, name;
            public GameObject blockout;
        }
        public readonly Dictionary<string, Entity> entities = new Dictionary<string, Entity>();
        public readonly HashSet<string> tags = new HashSet<string>();
        public readonly Dictionary<string, Color> colors = new Dictionary<string, Color>();
        public readonly List<string> warnings = new List<string>();
        public int levels, readable;
        public static MappingCatalog Read(OrlaMappings mappings)
        {
            var result = new MappingCatalog();
            var folders = new HashSet<string>();
            foreach (var level in UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Include))
            {
                if (level.mappings != mappings || !level.gameObject.scene.IsValid() || !level.gameObject.scene.isLoaded || EditorUtility.IsPersistent(level)) continue;
                result.levels++;
                try
                {
                    if (string.IsNullOrEmpty(level.folder)) throw new Exception("No export folder selected.");
                    var folder = Assets.FullPath(level.folder);
                    if (!folders.Add(folder)) continue;
                    var manifest = Manifest.Read(folder);
                    result.readable++;
                    foreach (var e in manifest.entities ?? Array.Empty<EntityRecord>())
                    {
                        if (string.IsNullOrEmpty(e.id)) continue;
                        var path = manifest.project != null && !string.IsNullOrEmpty(manifest.project.id)
                            ? $"{Assets.ProjectRoot(manifest.project.id)}/Entities/{Assets.Safe(e.id)}.prefab" : "";
                        if (!result.entities.ContainsKey(e.id)) result.entities[e.id] = new Entity { id = e.id, name = string.IsNullOrEmpty(e.name) ? e.id : e.name,
                            blockout = string.IsNullOrEmpty(path) ? null : AssetDatabase.LoadAssetAtPath<GameObject>(path) };
                    }
                    foreach (var t in manifest.tags ?? Array.Empty<LibraryEntry>()) if (!string.IsNullOrEmpty(t.name)) result.tags.Add(t.name);
                    foreach (var c in manifest.palette ?? Array.Empty<PaletteEntry>())
                        if (!string.IsNullOrEmpty(c.key)) result.colors[c.key] = ColorUtility.TryParseHtmlString(c.color, out var color) ? color : Color.gray;
                }
                catch (Exception e) { result.warnings.Add($"{level.name}: {e.Message}"); }
            }
            return result;
        }
        public string Name(string id) => entities.TryGetValue(id ?? "", out var e) ? e.name : id;
        public List<string> EntityIds(OrlaMappings m) => entities.Keys.Concat(m.entities.Select(e => e.entity ?? "")).Distinct().OrderBy(Name, StringComparer.OrdinalIgnoreCase).ToList();
        public static bool ValidPrefab(GameObject prefab) => prefab != null && EditorUtility.IsPersistent(prefab) && PrefabUtility.IsPartOfPrefabAsset(prefab);
        public string Status(OrlaMappings m, string id)
        {
            var rules = m.entities.Where(e => (e.entity ?? "") == id).ToList();
            if (rules.Count > 1) return "Invalid: duplicate rules";
            if (string.IsNullOrWhiteSpace(id)) return "Invalid: empty ID";
            if (rules.Count == 1 && !ValidPrefab(rules[0].prefab)) return "Invalid: missing prefab";
            return rules.Count == 0 ? "Unmapped" : "Mapped";
        }
        public List<string> Filter(OrlaMappings m, string search, int filter)
        {
            var rules = m.entities.GroupBy(e => e.entity ?? "").ToDictionary(g => g.Key, g => g.ToList());
            return EntityIds(m).Where(id =>
            {
                string status = Status(m, id);
                if (filter == 1 && status != "Mapped" || filter == 2 && status != "Unmapped" || filter == 3 && !status.StartsWith("Invalid") || filter == 4 && entities.ContainsKey(id)) return false;
                var text = Name(id) + " " + id;
                if (rules.TryGetValue(id, out var rows)) foreach (var e in rows) if (e.prefab != null) text += " " + e.prefab.name;
                return string.IsNullOrEmpty(search) || text.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
            }).ToList();
        }
    }
}
