using System;
using System.Collections.Generic;
using UnityEngine;

namespace Orlablocks
{
    /// <summary>
    /// How an orlablocks project's things become the game's (plan 15 §9): an entity as your own prefab, a tag as a
    /// layer, a Unity tag, components or static flags, a palette color as your materials. A Level points at one
    /// (one per project is the idea: a project's entity prefabs are shared by its Levels). Changing it re-applies it
    /// on the next sync.
    /// </summary>
    [CreateAssetMenu(menuName = "Orlablocks/Mappings", fileName = "Orlablocks Mappings")]
    public class OrlaMappings : ScriptableObject
    {
        public List<EntityMapping> entities = new List<EntityMapping>();
        public List<TagMapping> tags = new List<TagMapping>();
        public List<ColorMapping> colors = new List<ColorMapping>();

        /// <summary>What happens to the generated blockout of a mapped entity's instances.</summary>
        public enum Blockout
        {
            [Tooltip("Only your prefab")] Replace,
            [Tooltip("Your prefab, with the blockout under it, turned off (to compare)")] KeepHidden,
            [Tooltip("Your prefab, with the blockout under it")] Keep,
        }

        [Serializable]
        public class EntityMapping
        {
            [Tooltip("The orlablocks entity's ID")]
            public string entity = "";
            public GameObject prefab;
            [Tooltip("Your prefab's scale, times the instance's (1: as it is)")]
            public float scale = 1f;
            [Tooltip("Where your prefab sits from the entity's pivot, in meters in the entity's own frame (it grows with the instance's scale): a broom whose pivot is its middle, not the floor")]
            public Vector3 offset;
            [Tooltip("Your prefab turned from the entity's orientation, in degrees")]
            public Vector3 rotation;
            public Blockout blockout = Blockout.Replace;
        }

        [Serializable]
        public class TagMapping
        {
            [Tooltip("The orlablocks tag, without #")]
            public string tag = "";
            public bool setLayer;
            public int layer;
            [Tooltip("A Unity tag (it must exist in Tags and Layers); empty: none")]
            public string unityTag = "";
            [Tooltip("Components added to what carries the tag (never removed by a sync), by type name")]
            public List<string> components = new List<string>();
            [Tooltip("StaticEditorFlags added (as a number: the editor shows them as flags)")]
            public int staticFlags;
            [Tooltip("Notes and lines under it reach builds (they're EditorOnly otherwise): a route the game reads")]
            public bool keepInBuilds;
        }

        [Serializable]
        public class ColorMapping
        {
            [Tooltip("The palette key (blue, almost-white, ...)")]
            public string color = "";
            public Material body;
            [Tooltip("A room's floor; empty: the body's")]
            public Material floor;
        }
    }
}
