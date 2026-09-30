using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    /// <summary>
    /// What orlablocks shows that a game doesn't draw (plan 15 §8), in the Scene view only:
    /// - notes: a pin and a flag in their color (faint when done), with the label and the start of the text, or all
    ///   of it when selected; the Level's Show notes turns the text off;
    /// - lines: the curve in its color and width, dashed or not, with arrowheads;
    /// - holes: their solid as a wireframe, when selected or with the Level's Show holes on.
    /// </summary>
    public static class OrlaGizmos
    {
        static GUIStyle noteStyle;

        static GUIStyle NoteStyle()
        {
            if (noteStyle != null) return noteStyle;
            noteStyle = new GUIStyle(EditorStyles.helpBox) { fontSize = 11, wordWrap = true, richText = false };
            noteStyle.normal.textColor = EditorGUIUtility.isProSkin ? new Color(0.92f, 0.92f, 0.9f) : new Color(0.15f, 0.15f, 0.14f);
            return noteStyle;
        }

        static OrlaLevel LevelOf(Component c) => c.GetComponentInParent<OrlaLevel>();

        [DrawGizmo(GizmoType.NonSelected | GizmoType.Selected | GizmoType.Pickable)]
        static void DrawNote(OrlaNote note, GizmoType type)
        {
            var selected = (type & GizmoType.Selected) != 0;
            var c = note.color;
            if (note.status == "done") c.a = 0.35f;
            var foot = note.transform.position;
            var top = foot + Vector3.up * 1.2f;
            Gizmos.color = c;
            Gizmos.DrawLine(foot, top);
            Gizmos.DrawCube(top + new Vector3(0.25f, -0.15f, 0f), new Vector3(0.5f, 0.3f, 0.02f));

            var level = LevelOf(note);
            if (!selected && level != null && !level.showNotes) return;
            var text = note.text ?? "";
            if (!selected)
            {
                var firstLine = text.Split('\n')[0];
                text = firstLine.Length > 48 ? firstLine.Substring(0, 47) + "…" : firstLine;
            }
            var label = string.IsNullOrEmpty(note.label) ? text : $"{note.label} · {text}";
            if (note.status == "done") label = $"✓ {label}";
            if (label.Length == 0) return;
            var style = NoteStyle();
            // A selected note shows all of its text, wrapped to a readable width.
            style.fixedWidth = selected ? 260 : 0;
            Handles.Label(top + Vector3.up * 0.15f, label, style);
        }

        [DrawGizmo(GizmoType.NonSelected | GizmoType.Selected | GizmoType.Pickable)]
        static void DrawLine(OrlaLine line, GizmoType type)
        {
            var points = line.WorldPoints();
            if (points.Length < 2) return;
            var selected = (type & GizmoType.Selected) != 0;
            Handles.color = selected ? Color.Lerp(line.color, Color.white, 0.4f) : line.color;
            var width = Mathf.Max(1f, line.thickness) * (selected ? 1.5f : 1f);
            if (line.dashed)
                for (int i = 1; i < points.Length; i++) Handles.DrawDottedLine(points[i - 1], points[i], 4f);
            else Handles.DrawAAPolyLine(width, points);
            if (Event.current.type != EventType.Repaint) return;
            if (line.arrow == "end" || line.arrow == "both") Arrow(points[points.Length - 2], points[points.Length - 1]);
            if (line.arrow == "both") Arrow(points[1], points[0]);
        }

        static void Arrow(Vector3 from, Vector3 to)
        {
            var dir = to - from;
            if (dir.sqrMagnitude < 1e-8f) return;
            var size = HandleUtility.GetHandleSize(to) * 0.12f;
            Handles.ConeHandleCap(0, to - dir.normalized * size * 0.7f, Quaternion.LookRotation(dir), size, EventType.Repaint);
        }

        [DrawGizmo(GizmoType.NonSelected | GizmoType.Selected)]
        static void DrawHole(OrlaNode node, GizmoType type)
        {
            if (node.kind != "hole") return;
            var selected = (type & GizmoType.Selected) != 0;
            var level = LevelOf(node);
            if (!selected && (level == null || !level.showHoles)) return;
            var filter = node.GetComponent<MeshFilter>();
            if (filter == null || filter.sharedMesh == null) return;
            var t = node.transform;
            Gizmos.color = selected ? new Color(0.35f, 0.62f, 0.95f, 0.9f) : new Color(0.36f, 0.36f, 0.35f, 0.7f);
            Gizmos.DrawWireMesh(filter.sharedMesh, t.position, t.rotation, t.lossyScale);
        }
    }
}
