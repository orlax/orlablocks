// Scratch-only phase 18.1 experiment. Do not install in a production project.
using Orlablocks;
using UnityEngine;

namespace OrlablocksPrototype
{
    [DisallowMultipleComponent]
    public class PrototypePlacement : MonoBehaviour
    {
        public string projectId = "prototype", sceneId = "npc-fixture", expectedEntity = "npc";
        public GameObject inheritedPrefab;
        public OrlaMappings.EntityMapping inherited = new OrlaMappings.EntityMapping();
        public bool overridden;
        public OrlaMappings.EntityMapping replacement = new OrlaMappings.EntityMapping();
        // Explicit object references: neither names nor child indices identify owned content.
        public GameObject managedChild;
        public GameObject blockoutPrefab, managedBlockout;
    }
}
