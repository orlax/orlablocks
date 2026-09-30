using UnityEngine;

namespace Orlablocks
{
    /// <summary>
    /// An orlablocks scene synced into Unity (plan 15 §6–§7): the root its nodes are built under. It knows which
    /// export folder it syncs from (the scene's own folder, the one with level.json in it), what the last sync was,
    /// and what that sync left alone. Sync it from its inspector, or turn on Auto sync.
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("Orlablocks/Orlablocks Level")]
    public class OrlaLevel : MonoBehaviour
    {
        [Tooltip("The scene's export folder (the one holding level.json): relative to the Unity project, or absolute.")]
        public string folder = "";

        [Tooltip("Sync on its own when orlablocks exports this scene again (at most once a second, never in Play mode)")]
        public bool autoSync;

        [Tooltip("Entities as your prefabs, tags as layers and components, colors as your materials (optional)")]
        public OrlaMappings mappings;

        [Header("Last sync")]
        public string project = "";
        public string sceneId = "";
        public string sceneName = "";
        public int exportId = -1;
        public string syncedAt = "";

        [TextArea(2, 8)]
        public string report = "";

        [Tooltip("Moved in Unity since the last sync: left where they are. Revert them or claim them.")]
        public GameObject[] movedInUnity = new GameObject[0];
        [Tooltip("Claimed here, and changed in orlablocks since")]
        public GameObject[] claimedChanged = new GameObject[0];
        [Tooltip("Claimed here, and removed in orlablocks")]
        public GameObject[] goneFromOrlablocks = new GameObject[0];
    }
}
