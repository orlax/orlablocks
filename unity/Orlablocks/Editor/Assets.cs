using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>Where generated assets go (plan 15 §6), and folders made on the way.</summary>
    public static class Assets
    {
        public const string GeneratedRoot = "Assets/OrlablocksGenerated";

        /// <summary>A project's generated folder: its materials, textures, entity prefabs and level meshes.</summary>
        public static string ProjectRoot(string project) => $"{GeneratedRoot}/{Safe(project)}";

        /// <summary>A file or folder name from an orlablocks ID (they're slugs already; this guards the rest).</summary>
        public static string Safe(string id)
        {
            var chars = id.ToCharArray();
            for (int i = 0; i < chars.Length; i++)
                if (!(char.IsLetterOrDigit(chars[i]) || chars[i] == '-' || chars[i] == '_')) chars[i] = '_';
            return new string(chars);
        }

        /// <summary>Makes an asset folder (and its parents) if it's missing.</summary>
        public static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            var parent = Path.GetDirectoryName(path)?.Replace('\\', '/');
            if (!string.IsNullOrEmpty(parent)) EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }

        /// <summary>A folder as the file system sees it: relative ones are relative to the Unity project.</summary>
        public static string FullPath(string folder)
        {
            if (string.IsNullOrEmpty(folder)) return "";
            if (Path.IsPathRooted(folder)) return folder;
            return Path.GetFullPath(Path.Combine(Application.dataPath, "..", folder));
        }

        /// <summary>A folder as a Level keeps it: relative to the Unity project when it's inside it (so the project can move).</summary>
        public static string StoredPath(string full)
        {
            var project = Path.GetFullPath(Path.Combine(Application.dataPath, "..")).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var f = Path.GetFullPath(full);
            return f.StartsWith(project, StringComparison.Ordinal) ? f.Substring(project.Length).Replace('\\', '/') : f;
        }
    }

    /// <summary>
    /// Meshes as sub-assets, named by the export's hash of each: a mesh whose hash is already there is reused as it
    /// is, and Prune removes the ones this sync didn't use. A level's meshes are split over up to 16 files by their
    /// hash's first character (<c>Levels/&lt;scene&gt;/meshes-a.asset</c>), so a change rewrites one file, not all of
    /// them; an entity's are one file. Only files that changed are written (Save).
    /// </summary>
    public class MeshStore
    {
        readonly string basePath;
        readonly bool sharded;
        readonly Dictionary<string, OrlaMeshes> files = new Dictionary<string, OrlaMeshes>();
        readonly Dictionary<string, Mesh> byName = new Dictionary<string, Mesh>();
        readonly Dictionary<string, string> fileOf = new Dictionary<string, string>();
        readonly HashSet<string> used = new HashSet<string>();
        readonly HashSet<string> dirty = new HashSet<string>();
        public int Made { get; private set; }
        public int Removed { get; private set; }

        /// <param name="basePath">Without extension: Levels/&lt;scene&gt; or Entities/&lt;entity&gt;.</param>
        /// <param name="sharded">Split over files by hash (a level); one file otherwise (an entity).</param>
        public MeshStore(string basePath, bool sharded)
        {
            this.basePath = basePath;
            this.sharded = sharded;
            // The one-file store (every store before 15.5, and an entity's): read, reused, emptied as it's pruned.
            Load($"{basePath}.meshes.asset");
            if (sharded && AssetDatabase.IsValidFolder(basePath))
                foreach (var guid in AssetDatabase.FindAssets("t:OrlaMeshes", new[] { basePath }))
                    Load(AssetDatabase.GUIDToAssetPath(guid));
        }

        void Load(string path)
        {
            var main = AssetDatabase.LoadAssetAtPath<OrlaMeshes>(path);
            if (main == null) return;
            files[path] = main;
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
                if (o is Mesh m && !byName.ContainsKey(m.name))
                {
                    byName[m.name] = m;
                    fileOf[m.name] = path;
                }
        }

        string FileFor(string key)
        {
            if (!sharded) return $"{basePath}.meshes.asset";
            var c = key.Length > 0 && Uri.IsHexDigit(key[0]) ? char.ToLowerInvariant(key[0]) : '_';
            return $"{basePath}/meshes-{c}.asset";
        }

        OrlaMeshes Open(string path)
        {
            if (files.TryGetValue(path, out var main) && main != null) return main;
            Assets.EnsureFolder(Path.GetDirectoryName(path).Replace('\\', '/'));
            main = ScriptableObject.CreateInstance<OrlaMeshes>();
            AssetDatabase.CreateAsset(main, path);
            files[path] = main;
            return main;
        }

        public Mesh Get(string key, Func<Mesh> make)
        {
            used.Add(key);
            if (byName.TryGetValue(key, out var known) && known != null) return known;
            var mesh = make();
            mesh.name = key;
            var path = FileFor(key);
            AssetDatabase.AddObjectToAsset(mesh, Open(path));
            byName[key] = mesh;
            fileOf[key] = path;
            dirty.Add(path);
            Made++;
            return mesh;
        }

        /// <summary>Whether this is one of the store's meshes.</summary>
        public bool Holds(Mesh mesh) => mesh != null && byName.TryGetValue(mesh.name, out var m) && m == mesh;

        /// <summary>Keeps every store mesh that something under <paramref name="root"/> still uses (unchanged, claimed or orphaned objects).</summary>
        public void KeepReferenced(GameObject root)
        {
            foreach (var f in root.GetComponentsInChildren<MeshFilter>(true)) if (Holds(f.sharedMesh)) used.Add(f.sharedMesh.name);
            foreach (var c in root.GetComponentsInChildren<MeshCollider>(true)) if (Holds(c.sharedMesh)) used.Add(c.sharedMesh.name);
        }

        /// <summary>Removes the meshes nothing uses, and files left empty.</summary>
        public void Prune()
        {
            foreach (var pair in byName)
            {
                if (used.Contains(pair.Key) || pair.Value == null) continue;
                AssetDatabase.RemoveObjectFromAsset(pair.Value);
                UnityEngine.Object.DestroyImmediate(pair.Value, true);
                dirty.Add(fileOf[pair.Key]);
                Removed++;
            }
            var left = new HashSet<string>(used.Where(fileOf.ContainsKey).Select(k => fileOf[k]));
            foreach (var path in dirty.ToList())
                if (!left.Contains(path) && files.ContainsKey(path))
                {
                    AssetDatabase.DeleteAsset(path);
                    files.Remove(path);
                    dirty.Remove(path);
                }
        }

        /// <summary>Writes the files that changed (and only those).</summary>
        public void Save()
        {
            foreach (var path in dirty)
                if (files.TryGetValue(path, out var main) && main != null)
                {
                    EditorUtility.SetDirty(main);
                    AssetDatabase.SaveAssetIfDirty(main);
                }
            dirty.Clear();
        }
    }
}
