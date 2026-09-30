using UnityEngine;

namespace Orlablocks
{
    /// <summary>
    /// On every GameObject a sync made (plan 15 §6–§7): the orlablocks node it is, by ID, and what orlablocks knows
    /// about it. A sync finds its objects by this ID and leaves one alone when its record hasn't changed (its rev).
    /// On an entity prefab's root, <c>type</c> is "entity" and <c>id</c> the entity's ID; inside an entity, IDs are
    /// the entity's own (box_1), unique within the entity.
    ///
    /// What a sync owns on it: its transform, name, meshes, materials, collider and these fields. Everything else
    /// (children, components you add) is yours. <see cref="claimed"/> makes all of it yours: syncs stop changing it
    /// and what's under it.
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("Orlablocks/Orlablocks Node")]
    public class OrlaNode : MonoBehaviour
    {
        public string id = "";
        [Tooltip("group, box, cylinder, freeform, ramp, instance, array, item, note, line, or entity (an entity prefab's root)")]
        public string type = "";
        [Tooltip("room, volume or hole (closed shapes and ramps)")]
        public string kind = "";
        [Tooltip("The palette color it was drawn in")]
        public string color = "";
        [Tooltip("Instances and items: the entity they place")]
        public string entity = "";
        public string[] tags = new string[0];
        [TextArea(1, 6)]
        public string description = "";
        [Tooltip("What its meshes were made from: a sync rebuilds them only when this changes")]
        public string hash = "";

        [Tooltip("Claimed: this and what's under it are Unity's now, and syncs leave them alone")]
        public bool claimed;

        // What the last sync set, to tell a change made in Unity (drift) from one made in orlablocks.
        [HideInInspector] public string rev = "";
        [HideInInspector] public string syncedParent = "";
        [HideInInspector] public Vector3 syncedPosition;
        [HideInInspector] public Quaternion syncedRotation = Quaternion.identity;
        [HideInInspector] public Vector3 syncedScale = Vector3.one;
        // Set by Revert: the next sync takes orlablocks' transform even though it was moved in Unity.
        [HideInInspector] public bool revert;
        // An instance's children that have a cut mesh of their own (by their entity IDs), to undo when no longer cut.
        [HideInInspector] public string[] cutShapes = new string[0];
    }
}
