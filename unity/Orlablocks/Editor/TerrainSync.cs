using System;
using System.IO;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>Fingerprint the managed terrain fields as Unity actually stores them (including height quantization).
    /// Trees, details, alphamap painting, extra components and children are not owned by sync.</summary>
    public static class TerrainSync
    {
        static string Key(UnityEngine.Object o) => o == null ? "" : AssetDatabase.GetAssetPath(o);

        public static string Fingerprint(GameObject go)
        {
            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream);
            var terrain = go.GetComponent<Terrain>();
            var data = terrain != null ? terrain.terrainData : null;
            writer.Write(terrain != null);
            writer.Write(Key(data));
            if (data != null)
            {
                writer.Write(data.heightmapResolution);
                writer.Write(data.size.x); writer.Write(data.size.y); writer.Write(data.size.z);
                var heights = data.GetHeights(0, 0, data.heightmapResolution, data.heightmapResolution);
                foreach (float h in heights) writer.Write(h);
                foreach (var layer in data.terrainLayers)
                {
                    writer.Write(Key(layer));
                    if (layer == null) continue;
                    writer.Write(Key(layer.diffuseTexture));
                    writer.Write(layer.tileSize.x); writer.Write(layer.tileSize.y);
                    if (layer.diffuseTexture != null && layer.diffuseTexture.isReadable)
                        foreach (var c in layer.diffuseTexture.GetPixels32()) { writer.Write(c.r); writer.Write(c.g); writer.Write(c.b); writer.Write(c.a); }
                }
            }
            var material = terrain != null ? terrain.materialTemplate : null;
            writer.Write(Key(material)); writer.Write(material != null && material.shader != null ? material.shader.name : "");
            var collider = go.GetComponent<TerrainCollider>();
            writer.Write(collider != null); writer.Write(collider != null && collider.enabled);
            writer.Write(Key(collider != null ? collider.terrainData : null));
            writer.Flush();
            using var sha = SHA256.Create();
            return Convert.ToBase64String(sha.ComputeHash(stream.ToArray()));
        }

        public static bool Drifted(OrlaNode node) => node.type == "terrain" && !string.IsNullOrEmpty(node.syncedTerrain)
            && node.syncedTerrain != Fingerprint(node.gameObject);

        public static bool NeedsDecisionOnRemoval(OrlaNode node) => Drifted(node) ||
            (node.type == "terrain" && string.IsNullOrEmpty(node.syncedTerrain) && !string.IsNullOrEmpty(node.rev));

        /// <summary>16.1 imports have no stored content baseline. Accept a matching unchanged export once;
        /// otherwise require the same explicit Revert/Claim decision as an ordinary sculpt conflict.</summary>
        public static bool LegacyDrifted(OrlaNode node, NodeRecord record, MeshBinary binary)
        {
            if (node.type != "terrain" || !string.IsNullOrEmpty(node.syncedTerrain) || string.IsNullOrEmpty(node.rev)) return false;
            if (node.rev.Split('|')[0] != record.rev) return true;
            var terrain = node.GetComponent<Terrain>(); var data = terrain != null ? terrain.terrainData : null;
            if (data == null || data.heightmapResolution != record.terrain.resolution || data.size != NodeRecord.V(record.terrain.size)) return true;
            var expected = binary.Heights(record.terrain); var actual = data.GetHeights(0, 0, data.heightmapResolution, data.heightmapResolution);
            for (int z = 0; z < data.heightmapResolution; z++) for (int x = 0; x < data.heightmapResolution; x++)
                if (Mathf.Abs(expected[z,x] - actual[z,x]) > 2f / 65535f) return true;
            var collider = node.GetComponent<TerrainCollider>();
            return (record.collider == "terrain") != (collider != null) || (collider != null && (!collider.enabled || collider.terrainData != data));
        }

        /// <summary>Legacy Levels could share generated assets. Never write through a claimed object's references.</summary>
        public static bool Protected(TerrainData data, Material material)
        {
            foreach (var terrain in UnityEngine.Object.FindObjectsByType<Terrain>(FindObjectsInactive.Include))
            {
                var other = terrain.terrainData;
                bool shares = (data != null && other == data) || (material != null && terrain.materialTemplate == material);
                if (data != null && other != null && !shares)
                    foreach (var a in other.terrainLayers) foreach (var b in data.terrainLayers)
                        if (a != null && b != null && (a == b || (a.diffuseTexture != null && a.diffuseTexture == b.diffuseTexture))) shares = true;
                if (!shares) continue;
                for (var t = terrain.transform; t != null; t = t.parent)
                    if (t.GetComponent<OrlaNode>() is OrlaNode n && n.claimed) return true;
            }
            return false;
        }
    }
}
