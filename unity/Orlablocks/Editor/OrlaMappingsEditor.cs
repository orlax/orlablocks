using UnityEditor;
using UnityEngine;

namespace Orlablocks.Editor
{
    [CustomEditor(typeof(OrlaMappings))]
    public class OrlaMappingsEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            var mappings = (OrlaMappings)target;
            EditorGUILayout.LabelField($"{mappings.entities.Count} entity rules · {mappings.tags.Count} tag rules · {mappings.colors.Count} color rules", EditorStyles.wordWrappedLabel);
            EditorGUILayout.HelpBox("Changes apply on the next Sync of each Level using this asset. Generated entity prefabs are shared within a project; use the same mappings for its Levels.", MessageType.None);
            if (GUILayout.Button("Open mapping browser")) OrlaMappingBrowser.Open(mappings);
        }
    }
}
