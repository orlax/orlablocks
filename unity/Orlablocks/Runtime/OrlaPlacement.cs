using UnityEngine;

namespace Orlablocks
{
    /// <summary>Stable scene placement ownership. Gameplay references should target this parent.</summary>
    [DisallowMultipleComponent, AddComponentMenu("")]
    public class OrlaPlacement : MonoBehaviour
    {
        [HideInInspector] public string project, scene;
        [HideInInspector] public GameObject managedChild, managedBlockout;
        [HideInInspector] public string childBaseline, blockoutBaseline;
        [HideInInspector] public bool overridden;
        [HideInInspector] public string expectedEntity;
        [HideInInspector] public OrlaMappings.EntityMapping replacement = new OrlaMappings.EntityMapping();
        [HideInInspector] public string problem;
    }
}
