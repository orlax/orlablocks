using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// A Level's mappings as a sync reads them (plan 15 §9): lookups by entity, tag and color, the component types
    /// resolved, and a fingerprint of the whole set. The fingerprint joins every object's rev, so changing a mapping
    /// makes the next sync apply it everywhere once. A mapping that can't apply (no prefab, an unknown script or
    /// Unity tag) is reported once and left out: the generated blockout stays.
    /// </summary>
    public class MappingSet
    {
        public readonly string Fingerprint = "";
        readonly Dictionary<string, OrlaMappings.EntityMapping> entities = new Dictionary<string, OrlaMappings.EntityMapping>();
        readonly Dictionary<string, List<OrlaMappings.TagMapping>> tags = new Dictionary<string, List<OrlaMappings.TagMapping>>();
        readonly Dictionary<string, OrlaMappings.ColorMapping> colors = new Dictionary<string, OrlaMappings.ColorMapping>();
        readonly Dictionary<string, Type> types = new Dictionary<string, Type>();
        readonly List<string> warnings;
        readonly HashSet<string> warned = new HashSet<string>();

        public MappingSet(OrlaMappings m, List<string> warnings)
        {
            this.warnings = warnings;
            if (m == null) return;
            var print = new StringBuilder();
            foreach (var e in m.entities)
            {
                if (string.IsNullOrEmpty(e.entity)) continue;
                print.Append($"e:{e.entity}:{Guid(e.prefab)}:{e.scale}:{e.blockout}:{e.offset}:{e.rotation};");
                if (e.prefab == null) Warn($"Mappings: the entity {e.entity} has no prefab, so its blockout stays.");
                else entities[e.entity] = e;
            }
            foreach (var t in m.tags)
            {
                if (string.IsNullOrEmpty(t.tag)) continue;
                var name = t.tag.TrimStart('#');
                print.Append($"t:{name}:{t.setLayer}:{t.layer}:{t.unityTag}:{string.Join(",", t.components)}:{t.staticFlags}:{t.keepInBuilds};");
                if (!tags.TryGetValue(name, out var list)) tags[name] = list = new List<OrlaMappings.TagMapping>();
                list.Add(t);
            }
            foreach (var c in m.colors)
            {
                if (string.IsNullOrEmpty(c.color)) continue;
                print.Append($"c:{c.color}:{Guid(c.body)}:{Guid(c.floor)};");
                if (c.body != null || c.floor != null) colors[c.color] = c;
            }
            if (print.Length == 0) return;
            using (var md5 = MD5.Create())
                Fingerprint = BitConverter.ToString(md5.ComputeHash(Encoding.UTF8.GetBytes(print.ToString()))).Replace("-", "").Substring(0, 12).ToLowerInvariant();
        }

        static string Guid(UnityEngine.Object o) =>
            o != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out var guid, out long local) ? $"{guid}/{local}" : "";

        public void Warn(string message)
        {
            if (warned.Add(message)) warnings.Add(message);
        }

        /// <summary>The mapping for an entity, if it has a prefab.</summary>
        public OrlaMappings.EntityMapping Entity(string id) => id != null && entities.TryGetValue(id, out var e) ? e : null;

        /// <summary>A color's own body material, or null for the generated one.</summary>
        public Material Body(string color) => color != null && colors.TryGetValue(color, out var c) ? c.body : null;

        /// <summary>A color's own floor material (its body's if it has no floor), or null for the generated one.</summary>
        public Material Floor(string color) => color != null && colors.TryGetValue(color, out var c) ? (c.floor != null ? c.floor : c.body) : null;

        /// <summary>The tag rules that apply to something carrying these tags (its own and what it's in).</summary>
        public List<OrlaMappings.TagMapping> Rules(IEnumerable<string> carried)
        {
            var found = new List<OrlaMappings.TagMapping>();
            foreach (var t in carried.Distinct())
                if (tags.TryGetValue(t, out var list)) found.AddRange(list);
            return found;
        }

        public bool HasTagRules => tags.Count > 0;

        /// <summary>A component type by the name a mapping keeps (its assembly-qualified name), or null (reported).</summary>
        public Type Component(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            if (types.TryGetValue(name, out var known)) return known;
            var t = Type.GetType(name);
            if (t == null || !typeof(Component).IsAssignableFrom(t) || t.IsAbstract)
            {
                Warn($"Mappings: no component {name.Split(',')[0]} (was the script renamed or removed?).");
                t = null;
            }
            types[name] = t;
            return t;
        }

        /// <summary>Whether a Unity tag exists (Tags and Layers), reporting it once if not.</summary>
        public bool TagExists(string tag)
        {
            if (UnityEditorInternal.InternalEditorUtility.tags.Contains(tag)) return true;
            Warn($"Mappings: there's no Unity tag \"{tag}\" (add it in Tags and Layers).");
            return false;
        }
    }
}
