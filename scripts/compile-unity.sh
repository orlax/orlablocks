#!/bin/bash
# Compiles unity/Orlablocks against a Unity editor's own assemblies, with its bundled Roslyn, without starting Unity
# (plan 15 §13): a check that the C# builds before it's imported into a project. Unity itself still has the last
# word (it compiles with its own defines and packages).
#
#   scripts/compile-unity.sh                        (Unity 6000.5.9f1, output in a temp folder)
#   UNITY=/Applications/Unity/Hub/Editor/<version>/Unity.app scripts/compile-unity.sh
set -euo pipefail
UNITY="${UNITY:-/Applications/Unity/Hub/Editor/6000.5.9f1/Unity.app}"
S="$UNITY/Contents/Resources/Scripting"
SRC="$(cd "$(dirname "$0")/.." && pwd)/unity/Orlablocks"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
CSC_DLL=$(ls -d "$S"/DotNetSdk/sdk/*/Roslyn/bincore/csc.dll | head -1)
CSC=("$S/DotNetSdk/dotnet" "$CSC_DLL")
ENGINE=(); for f in "$S"/Managed/UnityEngine/UnityEngine*.dll; do [[ "$f" == */UnityEngine.dll ]] || ENGINE+=("-r:$f"); done
EDITOR=(); for f in "$S"/Managed/UnityEngine/UnityEditor*.dll; do EDITOR+=("-r:$f"); done
BASE=(-nologo -noconfig -nostdlib -langversion:9.0 -target:library -warn:4 -nowarn:1701,1702 "-r:$S/NetStandard/ref/2.1.0/netstandard.dll")
"${CSC[@]}" "${BASE[@]}" "${ENGINE[@]}" -out:"$OUT/Orlablocks.Runtime.dll" "$SRC"/Runtime/*.cs
"${CSC[@]}" "${BASE[@]}" "${ENGINE[@]}" "${EDITOR[@]}" -r:"$OUT/Orlablocks.Runtime.dll" -out:"$OUT/Orlablocks.Editor.dll" "$SRC"/Editor/*.cs
echo "unity/Orlablocks compiles against Unity $(basename "$(dirname "$UNITY")")"
