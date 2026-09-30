using System;
using System.IO;
using UnityEngine;
using UnityEngine.Rendering;

namespace Orlablocks.Editor
{
    // level.json, as orlablocks writes it (plan 15 §3; src/server/export.ts). Every field is on every record, so
    // JsonUtility reads it with no custom parsing. Everything is already in Unity's frame: positions and eulers are
    // local to the parent, and a sync only copies them.

    [Serializable]
    public class Manifest
    {
        public string format;
        public int version;
        public int exportId;
        public string exportedAt;
        public ProjectInfo project;
        public SceneInfo scene;
        public MeshesInfo meshes;
        public PaletteEntry[] palette;
        public float floorShade;
        public LibraryEntry[] tags;
        public LibraryEntry[] skills;
        public EntityRecord[] entities;
        public NodeRecord[] nodes;

        public const string Format = "orlablocks-unity";
        public const int Version = 1;

        /// <summary>
        /// The exportId in a scene folder's level.json without reading the whole file (the watcher's cheap check), or
        /// -1. It's near the start: the manifest's header comes first.
        /// </summary>
        public static int PeekExportId(string folder)
        {
            try
            {
                var file = Path.Combine(folder, "level.json");
                if (!File.Exists(file)) return -1;
                using (var reader = new StreamReader(file))
                {
                    var buffer = new char[512];
                    var n = reader.Read(buffer, 0, buffer.Length);
                    var head = new string(buffer, 0, n);
                    var at = head.IndexOf("\"exportId\":", StringComparison.Ordinal);
                    if (at < 0) return -1;
                    at += "\"exportId\":".Length;
                    int end = at;
                    while (end < head.Length && (char.IsDigit(head[end]) || head[end] == '-')) end++;
                    return int.TryParse(head.Substring(at, end - at), out var id) ? id : -1;
                }
            }
            catch (IOException)
            {
                // Being written: next time.
                return -1;
            }
        }

        /// <summary>Reads a scene's export folder's level.json. Throws with a readable message if it isn't one.</summary>
        public static Manifest Read(string folder)
        {
            var file = Path.Combine(folder, "level.json");
            if (!File.Exists(file)) throw new Exception($"No level.json in {folder}. Pick the scene's folder (it's named by the scene's ID), not the project's.");
            var m = JsonUtility.FromJson<Manifest>(File.ReadAllText(file));
            if (m == null || m.format != Format) throw new Exception($"{file} isn't an orlablocks export.");
            if (m.version > Version) throw new Exception($"{file} is export version {m.version}; these Orlablocks files read up to {Version}. Update them from the orlablocks repo.");
            return m;
        }
    }

    [Serializable] public class ProjectInfo { public string id; public string name; public string description; }
    [Serializable] public class SceneInfo { public string id; public string name; }
    [Serializable] public class MeshesInfo { public string file; public int bytes; public string hash; }
    [Serializable] public class PaletteEntry { public string key; public string color; }
    [Serializable] public class LibraryEntry { public string name; public string description; }

    [Serializable]
    public class EntityRecord
    {
        public string id;
        public string name;
        public string description;
        public string[] tags;
        public string hash;
        public NodeRecord[] nodes;
    }

    [Serializable]
    public class MeshRange
    {
        public int offset;
        public int vertices;
        public int indices;
    }

    [Serializable]
    public class CutRecord
    {
        public string shape;
        public MeshRange body;
        public MeshRange floor;
        public string hash;
    }

    [Serializable]
    public class NodeRecord
    {
        public string id;
        public string type;
        public string kind;
        public string parent;
        public string name;
        public string description;
        public string[] tags;
        public string color;
        public float[] position;
        public float[] euler;
        public float scale;
        public bool hidden;
        public string hash;
        public string rev;
        public MeshRange body;
        public MeshRange floor;
        public string collider;
        public bool noColliders;
        public float[] boxCenter;
        public float[] boxSize;
        public string entity;
        public CutRecord[] cuts;
        public string text;
        public string label;
        public string status;
        public float[] points;
        public float thickness;
        public bool dashed;
        public string arrow;

        public bool IsShape => type == "box" || type == "cylinder" || type == "freeform" || type == "ramp";
        public bool IsPlacement => type == "instance" || type == "item";
        public bool HasMesh => body.vertices > 0 || floor.vertices > 0;
        public string GameObjectName => string.IsNullOrEmpty(name) ? id : $"{name} ({id})";
        public static Vector3 V(float[] a) => a != null && a.Length == 3 ? new Vector3(a[0], a[1], a[2]) : Vector3.zero;
    }

    /// <summary>
    /// The export's mesh binary: each mesh is its positions (float × 3), normals (float × 3), UVs (float × 2) and
    /// indices (uint), little-endian, from its range's offset.
    /// </summary>
    public class MeshBinary
    {
        readonly byte[] bytes;

        public MeshBinary(string folder, MeshesInfo info)
        {
            var file = Path.Combine(folder, info.file);
            if (!File.Exists(file)) throw new Exception($"{file} is missing: export the scene again.");
            bytes = File.ReadAllBytes(file);
            if (bytes.Length != info.bytes) throw new Exception($"{file} is {bytes.Length} bytes, not the {info.bytes} level.json says: export the scene again.");
        }

        float[] Floats(int offset, int count)
        {
            var f = new float[count];
            Buffer.BlockCopy(bytes, offset, f, 0, count * 4);
            return f;
        }

        /// <summary>One mesh from the parts (a body, a room's floor), each part a submesh, in order. Empty parts are skipped.</summary>
        public Mesh Build(string name, params MeshRange[] parts)
        {
            int vertexCount = 0;
            foreach (var p in parts) if (p != null) vertexCount += p.vertices;
            var positions = new Vector3[vertexCount];
            var normals = new Vector3[vertexCount];
            var uvs = new Vector2[vertexCount];
            var submeshes = new System.Collections.Generic.List<int[]>();
            int at = 0;
            foreach (var p in parts)
            {
                if (p == null || p.vertices == 0) continue;
                var pos = Floats(p.offset, p.vertices * 3);
                var nrm = Floats(p.offset + p.vertices * 12, p.vertices * 3);
                var uv = Floats(p.offset + p.vertices * 24, p.vertices * 2);
                for (int i = 0; i < p.vertices; i++)
                {
                    positions[at + i] = new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                    normals[at + i] = new Vector3(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
                    uvs[at + i] = new Vector2(uv[i * 2], uv[i * 2 + 1]);
                }
                var raw = new uint[p.indices];
                Buffer.BlockCopy(bytes, p.offset + p.vertices * 32, raw, 0, p.indices * 4);
                var idx = new int[p.indices];
                for (int i = 0; i < raw.Length; i++) idx[i] = (int)raw[i] + at;
                submeshes.Add(idx);
                at += p.vertices;
            }
            var mesh = new Mesh { name = name };
            if (vertexCount > 65535) mesh.indexFormat = IndexFormat.UInt32;
            mesh.vertices = positions;
            mesh.normals = normals;
            mesh.uv = uvs;
            mesh.subMeshCount = submeshes.Count;
            for (int s = 0; s < submeshes.Count; s++) mesh.SetTriangles(submeshes[s], s);
            mesh.RecalculateBounds();
            mesh.RecalculateTangents();
            return mesh;
        }
    }
}
