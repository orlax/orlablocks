using UnityEngine;

namespace Orlablocks
{
    /// <summary>
    /// An orlablocks note: a post-it pinned where this GameObject is (plan 15 §8). Synced notes are tagged
    /// EditorOnly, so they never reach a build.
    /// </summary>
    [AddComponentMenu("Orlablocks/Orlablocks Note")]
    public class OrlaNote : MonoBehaviour
    {
        [TextArea(2, 10)]
        public string text = "";
        public string label = "";
        [Tooltip("open or done")]
        public string status = "open";
        public Color color = new Color(0.95f, 0.89f, 0.64f);

        void OnDrawGizmos()
        {
            var c = color;
            if (status == "done") c.a = 0.35f;
            Gizmos.color = c;
            var top = transform.position + Vector3.up * 1.2f;
            Gizmos.DrawLine(transform.position, top);
            Gizmos.DrawCube(top + new Vector3(0.25f, -0.15f, 0f), new Vector3(0.5f, 0.3f, 0.02f));
        }
    }
}
