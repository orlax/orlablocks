using System;
using System.Collections.Generic;
using System.IO;
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
    /// A .meshes.asset: meshes as sub-assets of one file, named by the export's hash of each. A mesh whose hash is
    /// already there is reused as it is; Prune removes the ones this sync didn't use.
    /// </summary>
    public class MeshStore
    {
        readonly OrlaMeshes main;
        readonly Dictionary<string, Mesh> byName = new Dictionary<string, Mesh>();
        readonly HashSet<string> used = new HashSet<string>();
        public int Made { get; private set; }

        public MeshStore(string path)
        {
            main = AssetDatabase.LoadAssetAtPath<OrlaMeshes>(path);
            if (main == null)
            {
                Assets.EnsureFolder(Path.GetDirectoryName(path).Replace('\\', '/'));
                main = ScriptableObject.CreateInstance<OrlaMeshes>();
                AssetDatabase.CreateAsset(main, path);
            }
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
                if (o is Mesh m && !byName.ContainsKey(m.name)) byName[m.name] = m;
        }

        public Mesh Get(string key, Func<Mesh> make)
        {
            used.Add(key);
            if (byName.TryGetValue(key, out var known) && known != null) return known;
            var mesh = make();
            mesh.name = key;
            AssetDatabase.AddObjectToAsset(mesh, main);
            byName[key] = mesh;
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

        public void Prune()
        {
            foreach (var pair in byName)
            {
                if (used.Contains(pair.Key) || pair.Value == null) continue;
                AssetDatabase.RemoveObjectFromAsset(pair.Value);
                UnityEngine.Object.DestroyImmediate(pair.Value, true);
            }
            EditorUtility.SetDirty(main);
        }
    }
}
