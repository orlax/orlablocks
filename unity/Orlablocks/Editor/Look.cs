using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// The graybox look (plan 15 §6), made by code on first use so the Orlablocks files carry no binary assets: the
    /// 1 m prototype tile, drawn as the editor draws it, and two URP Lit materials per palette color (a body, and a
    /// room's floor a little darker), matte. A material is made only if it's missing: once made it's the user's to
    /// tune. Rebuild Materials on the Level remakes them.
    /// </summary>
    public class Look
    {
        const string LitShader = "Universal Render Pipeline/Lit";
        readonly string root;
        readonly Dictionary<string, string> palette = new Dictionary<string, string>();
        readonly float floorShade;
        readonly bool rebuild;
        readonly Dictionary<string, Material> made = new Dictionary<string, Material>();
        Texture2D tile;

        public readonly List<string> Warnings = new List<string>();

        /// <param name="root">The project's generated folder (Assets/OrlablocksGenerated/&lt;project&gt;).</param>
        public Look(string root, Manifest m, bool rebuild)
        {
            this.root = root;
            foreach (var p in m.palette) palette[p.key] = p.color;
            floorShade = m.floorShade > 0 ? m.floorShade : 0.94f;
            this.rebuild = rebuild;
        }

        /// <summary>The tile texture: white with a thin warm gray border, lines on whole meters (UVs are in meters).</summary>
        Texture2D Tile()
        {
            if (tile != null) return tile;
            var path = $"{root}/Textures/OrlaTile.png";
            tile = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (tile != null) return tile;
            Assets.EnsureFolder($"{root}/Textures");
            const int size = 256;
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
            var line = new Color32(0xc4, 0xbf, 0xb5, 0xff);
            var white = new Color32(0xff, 0xff, 0xff, 0xff);
            var half = Color32.Lerp(white, line, 0.5f);
            var pixels = new Color32[size * size];
            for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    // 3 px in all, split across the tile's edge so neighboring tiles join into one line.
                    bool full = x == 0 || y == 0 || x == size - 1 || y == size - 1;
                    bool soft = x == 1 || y == 1 || x == size - 2 || y == size - 2;
                    pixels[y * size + x] = full ? line : soft ? half : white;
                }
            tex.SetPixels32(pixels);
            File.WriteAllBytes(path, tex.EncodeToPNG());
            Object.DestroyImmediate(tex);
            AssetDatabase.ImportAsset(path);
            var importer = (TextureImporter)AssetImporter.GetAtPath(path);
            importer.wrapMode = TextureWrapMode.Repeat;
            importer.sRGBTexture = true;
            importer.anisoLevel = 8;
            importer.mipmapEnabled = true;
            importer.filterMode = FilterMode.Trilinear;
            importer.SaveAndReimport();
            tile = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            return tile;
        }

        public Material Body(string color) => Get(color, false);
        public Material Floor(string color) => Get(color, true);

        Material Get(string color, bool floor)
        {
            if (string.IsNullOrEmpty(color)) color = "almost-white";
            var name = floor ? $"orla-{color}-floor" : $"orla-{color}";
            if (made.TryGetValue(name, out var known)) return known;
            var path = $"{root}/Materials/{name}.mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null || rebuild)
            {
                var shader = Shader.Find(LitShader);
                if (shader == null)
                {
                    shader = Shader.Find("Standard");
                    const string noUrp = "URP isn't set up in this project: the materials use the Standard shader.";
                    if (!Warnings.Contains(noUrp)) Warnings.Add(noUrp);
                }
                bool fresh = mat == null;
                if (fresh) mat = new Material(shader);
                else mat.shader = shader;
                mat.name = name;
                ColorUtility.TryParseHtmlString(palette.TryGetValue(color, out var hex) ? hex : "#ededed", out var c);
                // The editor darkens a floor in linear color, as three.js does.
                if (floor) c = (c.linear * floorShade).gamma;
                c.a = 1f;
                mat.SetColor("_BaseColor", c);
                mat.SetColor("_Color", c);
                mat.SetTexture("_BaseMap", Tile());
                mat.SetTexture("_MainTex", Tile());
                mat.SetFloat("_Smoothness", 0f);
                mat.SetFloat("_Glossiness", 0f);
                mat.SetFloat("_Metallic", 0f);
                // Matte, like the editor's Lambert: no highlights, no reflections.
                mat.SetFloat("_SpecularHighlights", 0f);
                mat.EnableKeyword("_SPECULARHIGHLIGHTS_OFF");
                mat.SetFloat("_EnvironmentReflections", 0f);
                mat.EnableKeyword("_ENVIRONMENTREFLECTIONS_OFF");
                mat.enableInstancing = true;
                if (fresh)
                {
                    Assets.EnsureFolder($"{root}/Materials");
                    AssetDatabase.CreateAsset(mat, path);
                }
                else EditorUtility.SetDirty(mat);
            }
            made[name] = mat;
            return mat;
        }
    }
}
