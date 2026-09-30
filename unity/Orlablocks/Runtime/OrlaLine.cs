using UnityEngine;

namespace Orlablocks
{
    /// <summary>
    /// An orlablocks line (a route, a patrol, a jump arc): its curve as points relative to this GameObject
    /// (plan 15 §8), public so an editor tool can read a route. Synced lines are tagged EditorOnly.
    /// </summary>
    [AddComponentMenu("Orlablocks/Orlablocks Line")]
    public class OrlaLine : MonoBehaviour
    {
        public Vector3[] points = new Vector3[0];
        public Color color = Color.white;
        public bool dashed;
        [Tooltip("none, end or both")]
        public string arrow = "none";

        /// <summary>The points in world space.</summary>
        public Vector3[] WorldPoints()
        {
            var w = new Vector3[points.Length];
            for (int i = 0; i < points.Length; i++) w[i] = transform.TransformPoint(points[i]);
            return w;
        }

        void OnDrawGizmos()
        {
            if (points.Length < 2) return;
            Gizmos.color = color;
            var w = WorldPoints();
            for (int i = 1; i < w.Length; i++)
                if (!dashed || i % 2 == 1) Gizmos.DrawLine(w[i - 1], w[i]);
        }
    }
}
