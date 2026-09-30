using UnityEngine;

namespace Orlablocks
{
    /// <summary>
    /// An orlablocks note: a post-it pinned where this GameObject is (plan 15 §8), drawn in the Scene view as a flag
    /// with its text. Synced notes are tagged EditorOnly, so they never reach a build.
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
    }
}
