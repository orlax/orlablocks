using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Orlablocks;
using Orlablocks.Editor;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

// Real production importer checks. Refuses game projects.
public static class PlacementAcceptance
{
    static int checks;
    static string Root => Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; Debug.Log("PLACEMENT_CHECK " + message); }
    static Manifest m;
    static string folder;
    static void Write() { File.WriteAllText(Path.Combine(folder, "level.json"), JsonUtility.ToJson(m)); }
    static OrlaNode Node(OrlaLevel level, string id) => level.GetComponentsInChildren<OrlaNode>(true).First(n => n.id == id && n.GetComponent<OrlaPlacement>() != null);
    static GameObject Prefab(string name) { var go = GameObject.CreatePrimitive(PrimitiveType.Capsule); go.name = name; var asset = PrefabUtility.SaveAsPrefabAsset(go,"Assets/PlacementFixture/"+name+".prefab"); UnityEngine.Object.DestroyImmediate(go); return asset; }
    static bool Is(OrlaPlacement p, GameObject prefab) => PrefabUtility.GetCorrespondingObjectFromSource(p.managedChild) == prefab;
    static void Reject(Action action, string label) { bool rejected = false; try { action(); } catch (InvalidOperationException) { rejected = true; } Check(rejected,label); }
    public static void Run() { EditorApplication.delayCall += Checks; }
    static void Checks()
    {
        try
        {
            if (Root != "/private/tmp/orla-mappings-18-overrides") throw new Exception("Requires isolated /private/tmp/orla-mappings-18-overrides");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            AssetDatabase.DeleteAsset("Assets/PlacementFixture"); AssetDatabase.DeleteAsset(Assets.ProjectRoot("placement_fixture"));
            Assets.EnsureFolder("Assets/PlacementFixture");
            var guard = Prefab("Guard"); var merchant = Prefab("Merchant"); var inherited = Prefab("Inherited");
            var mappings = ScriptableObject.CreateInstance<OrlaMappings>(); AssetDatabase.CreateAsset(mappings,"Assets/PlacementFixture/Mappings.asset");
            mappings.entities.Add(new OrlaMappings.EntityMapping { entity = "npc", prefab = inherited, scale = 1.5f, offset = new Vector3(0,1,0), rotation = new Vector3(0,20,0), blockout = OrlaMappings.Blockout.Keep });
            mappings.tags.Add(new OrlaMappings.TagMapping { tag = "npc", setLayer = true, layer = 8, components = new System.Collections.Generic.List<string> { typeof(AudioSource).AssemblyQualifiedName } });
            folder = Path.Combine(Root,"ExportFixture"); Directory.CreateDirectory(folder); File.WriteAllBytes(Path.Combine(folder,"meshes.bin"), Array.Empty<byte>());
            m = new Manifest { format = Manifest.Format, version = 2, exportId = 1, project = new ProjectInfo { id="placement_fixture", name="Fixture" }, scene = new SceneInfo { id="scene",name="NPCs" },
                meshes = new MeshesInfo { file="meshes.bin",bytes=0 }, palette = Array.Empty<PaletteEntry>(), tags=Array.Empty<LibraryEntry>(), skills=Array.Empty<LibraryEntry>(),
                entities = new[] { new EntityRecord { id="npc",name="NPC",hash="entity1",tags=new[]{"npc"}, nodes=Array.Empty<NodeRecord>() }, new EntityRecord { id="other",name="Other",hash="entity2",tags=Array.Empty<string>(),nodes=Array.Empty<NodeRecord>() } },
                nodes = Enumerable.Range(0,3).Select(i => new NodeRecord { id="npc"+i,type="instance",entity="npc",rev="v1",scale=2,position=new float[]{i*3,0,0},euler=new float[]{0,45,0}, tags=Array.Empty<string>() }).ToArray() };
            Write(); var level = new GameObject("Orlablocks Level").AddComponent<OrlaLevel>(); level.folder = folder; level.mappings = mappings;
            Sync.Run(level); var n = Node(level,"npc0"); var second = Node(level,"npc1"); var third = Node(level,"npc2"); var p = n.GetComponent<OrlaPlacement>();
            Check(n.transform.localPosition == Vector3.zero && n.transform.localScale == Vector3.one*2 && p.managedChild.transform.localPosition == Vector3.up && p.managedBlockout.transform.localPosition == Vector3.zero,"source parent and calibrated child/blockout sibling");
            Check(n.GetComponent<AudioSource>() != null && p.managedChild.layer == 8,"tag rules on stable parent and content");
            var user = new GameObject("User child"); user.transform.SetParent(n.transform,false); var component = n.gameObject.AddComponent<Light>();
            var reference = new GameObject("Gameplay reference").AddComponent<OrlaLine>(); reference.points = new Vector3[0];
            var joint = reference.gameObject.AddComponent<FixedJoint>(); var body = n.gameObject.AddComponent<Rigidbody>(); joint.connectedBody = body;
            Undo.ClearAll(); var unrelated = third.GetComponent<OrlaPlacement>().managedChild; var entityPath=Assets.ProjectRoot(m.project.id)+"/Entities/npc.prefab"; var entityTime=File.GetLastWriteTimeUtc(entityPath);
            Placements.Set(n,guard); Check(p.overridden && Is(p,guard) && p.replacement.scale==1.5f && p.replacement.offset==Vector3.up,"override immediately copies calibration");
            Check(user.transform.parent==n.transform && n.GetComponent<Light>()==component && joint.connectedBody==body,"parent components children and gameplay references survive");
            Check(third.GetComponent<OrlaPlacement>().managedChild==unrelated && File.GetLastWriteTimeUtc(entityPath)==entityTime && level.exportId==1,"local edit leaves unrelated child shared entity and checkpoint untouched");
            Undo.PerformUndo(); Check(!p.overridden && Is(p,inherited),"override Undo atomically restores child and state"); Undo.PerformRedo(); Check(p.overridden && Is(p,guard),"override Redo atomically restores child and state");
            Placements.Set(second,merchant); Check(Is(p,guard) && Is(second.GetComponent<OrlaPlacement>(),merchant) && Is(third.GetComponent<OrlaPlacement>(),inherited),"two distinct NPCs and third inheritance");
            Sync.Run(level); Check(!Placements.Edited(p) && string.IsNullOrEmpty(p.problem),"unchanged-export sync accepts managed baseline");
            mappings.entities[0].scale=3; mappings.entities[0].prefab=merchant; EditorUtility.SetDirty(mappings);
            m.nodes[0].position=new float[]{10,2,3}; m.nodes[0].euler=new float[]{0,90,0}; m.nodes[0].scale=4; m.nodes[0].hidden=true; m.nodes[0].rev="v2"; m.exportId++; Write(); Sync.Run(level);
            Check(n.transform.localPosition==new Vector3(10,2,3) && n.transform.localScale==Vector3.one*4 && Quaternion.Angle(n.transform.localRotation,Quaternion.Euler(0,90,0))<.01 && !n.gameObject.activeSelf,"source movement rotation scale visibility follow override");
            Check(p.replacement.scale==1.5f && Is(p,guard) && Is(third.GetComponent<OrlaPlacement>(),merchant),"global mapping affects inheritance without changing local calibration");
            Undo.FlushUndoRecordObjects(); Undo.PerformUndo();
            Check(n.transform.localPosition==Vector3.zero && n.transform.localScale==Vector3.one*2 && n.gameObject.activeSelf && p.overridden && Is(p,guard),"Sync Undo restores source parent transform visibility and local exception together");
            Undo.PerformRedo(); Check(n.transform.localPosition==new Vector3(10,2,3) && !n.gameObject.activeSelf && Is(p,guard) && !Placements.Edited(p),"Sync Redo restores representation and valid managed baseline");
            n.transform.localPosition=Vector3.one*99; var drift=n.transform.localPosition;
            Placements.Set(n,merchant); Check(n.transform.localPosition==drift,"immediate swap preserves parent drift"); Sync.Run(level); Check(level.movedInUnity.Contains(n.gameObject),"Sync reports parent drift");
            Nodes.Revert(new[]{n.gameObject}); Check(n.transform.localPosition==new Vector3(10,2,3) && p.overridden,"Revert retains override");
            Nodes.Claim(new[]{n.gameObject},true); Reject(()=>Placements.Set(n,guard),"Claim gates immediate override"); Nodes.Claim(new[]{n.gameObject},false);
            Undo.ClearAll(); Placements.Set(n,null,true); Check(!p.overridden && Is(p,merchant) && p.managedChild.transform.localScale==Vector3.one*3,"Clear immediately restores current inheritance");
            Undo.PerformUndo(); Check(p.overridden && p.replacement.scale==1.5f,"Clear Undo restores settings"); Undo.PerformRedo(); Check(!p.overridden && Is(p,merchant),"Clear Redo restores inherited representation");
            Placements.Set(n,guard); var kept=p.managedChild;
            p.managedChild.transform.localPosition+=Vector3.right; PrefabUtility.RecordPrefabInstancePropertyModifications(p.managedChild.transform);
            Reject(()=>Placements.Set(n,merchant),"direct calibration drift blocks swap"); Sync.Run(level); Check(p.managedChild==kept && p.problem.Contains("edited"),"Sync retains locally edited content");
            p.managedChild.transform.localPosition=p.replacement.offset; PrefabUtility.RecordPrefabInstancePropertyModifications(p.managedChild.transform);
            Check(!Placements.Edited(p),"restoring managed calibration resolves guard");
            p.managedChild.GetComponent<CapsuleCollider>().radius=.9f; PrefabUtility.RecordPrefabInstancePropertyModifications(p.managedChild.GetComponent<CapsuleCollider>());
            Reject(()=>Placements.Set(n,merchant),"prefab component edits block replacement"); PrefabUtility.RevertObjectOverride(p.managedChild.GetComponent<CapsuleCollider>(),InteractionMode.AutomatedAction);
            m.nodes[0].noColliders=true; m.nodes[0].rev="v3"; Write(); Sync.Run(level); Check(!p.managedChild.GetComponent<Collider>().enabled,"no-collisions applies to NPC root collider");
            m.nodes[0].entity="other"; m.nodes[0].rev="v4"; Write(); Sync.Run(level); Check(p.managedChild==kept && p.problem.Contains("entity/type"),"entity change retains representation for review");
            Placements.Set(n,merchant); Check(p.expectedEntity=="other" && Is(p,merchant),"explicit Override rebinds changed source entity");
            m.nodes[0].type="group"; m.nodes[0].rev="v5"; Write(); Sync.Run(level); Check(n.type=="instance" && p.problem.Contains("entity/type"),"source type change retained");
            m.nodes[0].type="instance"; m.nodes[0].entity="other"; Write(); Sync.Run(level);
            var records=m.nodes; m.nodes=records.Skip(1).ToArray(); Write(); Sync.Run(level); Check(n!=null && p.overridden && p.problem.Contains("missing"),"deleted source retains discoverable stable parent");
            m.nodes=records; Write(); Sync.Run(level); Check(Node(level,"npc0")==n && string.IsNullOrEmpty(p.problem),"restored source rebinds same parent");
            var oldScene=m.scene.id; m.scene.id="different"; Write(); Sync.Run(level); Check(p.problem.Contains("identity"),"colliding node ID from different source does not reuse override"); m.scene.id=oldScene; Write(); Sync.Run(level);
            var oldProject=m.project.id; m.project.id="other_project"; Write(); Sync.Run(level); Check(p.problem.Contains("identity"),"colliding node ID from different project cannot reuse override"); m.project.id=oldProject; Write(); Sync.Run(level);
            Selection.activeGameObject=level.gameObject; Unsupported.DuplicateGameObjectsUsingPasteboard(); var otherLevel=Selection.activeGameObject.GetComponent<OrlaLevel>(); otherLevel.name="Duplicated Level"; Sync.Run(otherLevel); var copyNode=Node(otherLevel,"npc0"); Placements.Set(copyNode,guard); Check(Is(p,merchant) && Is(copyNode.GetComponent<OrlaPlacement>(),guard),"duplicate Levels have independent serialized override references");
            Selection.activeGameObject=n.gameObject; Unsupported.DuplicateGameObjectsUsingPasteboard(); var copy=Selection.activeGameObject; Sync.Run(level); Check(copy.GetComponent<OrlaNode>().id=="" && n.id=="npc0","duplicate Unity source ID detached from sync"); UnityEngine.Object.DestroyImmediate(copy);
            // Failure after the first node's source transform has changed must roll the entire sync back.
            var before=n.transform.localPosition; var checkpoint=level.exportId; m.nodes[0].position=new float[]{42,0,0}; m.nodes[0].rev="rollback";
            m.nodes=m.nodes.Concat(new[]{new NodeRecord{id="bad",type="terrain",rev="bad",terrain=new TerrainRecord{resolution=5}}}).ToArray(); Write(); bool failed=false; try { Sync.Run(level); } catch { failed=true; }
            Check(failed && n.transform.localPosition==before && level.exportId==checkpoint && p.overridden && Is(p,merchant),"failed Sync rolls back transform checkpoint and override representation");
            m.nodes=records; Write(); Sync.Run(level);
            // Legacy root: mapping replacement and removal must preserve root and added state.
            var legacy=(GameObject)PrefabUtility.InstantiatePrefab(inherited,level.transform); var legacyNode=legacy.AddComponent<OrlaNode>(); legacyNode.id="legacy"; legacyNode.type="instance"; legacyNode.entity="npc"; legacy.AddComponent<Light>();
            m.nodes=records.Concat(new[]{new NodeRecord{id="legacy",type="instance",entity="npc",rev="legacy",scale=1}}).ToArray(); Write(); Sync.Run(level);
            Check(legacy!=null && legacy.GetComponent<Light>()!=null && level.report.Contains("Legacy placement"),"legacy prefab swap retained with migration conflict");
            Reject(()=>Placements.Set(legacyNode,guard),"legacy inspector override rejected with migration path"); m.nodes=records; Write(); Sync.Run(level); Check(legacy!=null,"legacy removal retains components and references");
            // Missing prefab state must not clear user-authored exception.
            Placements.Set(n,guard); kept=p.managedChild; p.replacement.prefab=null; Write(); Sync.Run(level); Check(p.overridden && p.managedChild==kept && p.problem.Contains("missing"),"missing prefab retains existing representation and override"); Placements.Set(n,merchant);
            // Exercise real cut meshes, including a failure after replacing the managed child.
            var bytes = new byte[108];
            Buffer.BlockCopy(new float[]{0,0,0,1,0,0,0,0,1, 0,1,0,0,1,0,0,1,0, 0,0,1,0,0,1},0,bytes,0,96);
            Buffer.BlockCopy(new uint[]{0,2,1},0,bytes,96,12); File.WriteAllBytes(Path.Combine(folder,"meshes.bin"),bytes); m.meshes.bytes=108;
            var shape = new NodeRecord { id="part",type="box",kind="volume",hash="triangle",rev="triangle",color="blue",scale=1,collider="box",boxSize=new float[]{1,1,1},body=new MeshRange{offset=0,vertices=3,indices=3},floor=new MeshRange() };
            m.palette=new[]{new PaletteEntry{key="blue",color="#2080ff"}};
            m.entities[1].nodes=new[]{shape}; m.entities[1].hash="with-shape"; m.nodes[0].noColliders=false; m.nodes[0].rev="with-shape"; Write(); Sync.Run(level);
            var settings = new OrlaMappings.EntityMapping { scale=2,blockout=OrlaMappings.Blockout.Keep };
            Placements.Set(n,merchant,false,settings);
            var beforeChild=p.managedChild; var beforeSettings=JsonUtility.ToJson(p.replacement);
            m.nodes[0].cuts=new[]{new CutRecord{shape="part",hash="invalid-cut",body=new MeshRange{offset=100000,vertices=3,indices=3},floor=new MeshRange()}}; Write();
            bool localFailed=false; try { Placements.Set(n,guard); } catch { localFailed=true; }
            Check(localFailed && p.managedChild==beforeChild && Is(p,merchant) && JsonUtility.ToJson(p.replacement)==beforeSettings,"failed immediate replacement rolls back destroyed child and serialized calibration");
            m.nodes[0].cuts=new[]{new CutRecord{shape="part",hash="valid-cut",body=shape.body,floor=shape.floor}}; m.nodes[0].rev="cut"; Write(); Sync.Run(level);
            var cutPart=p.managedBlockout.GetComponentsInChildren<OrlaNode>(true).First(part=>part.id=="part");

            Check(cutPart.GetComponent<MeshCollider>()!=null && !cutPart.GetComponent<BoxCollider>().enabled && !Placements.Edited(p),"kept blockout cut and baseline use shared production resolver");
            m.nodes[0].cuts=Array.Empty<CutRecord>(); m.nodes[0].rev="uncut"; Write(); Sync.Run(level);
            Check(cutPart.GetComponent<MeshCollider>()==null && cutPart.GetComponent<BoxCollider>().enabled,"removing cuts restores generated collider");
            // A source group can disappear together with an override: keep the parent in sync's index.
            var savedRecords=m.nodes; var groupRecord=new NodeRecord{id="group",type="group",rev="group",scale=1}; m.nodes[0].parent="group"; m.nodes[0].rev="grouped"; m.nodes=new[]{groupRecord}.Concat(savedRecords).ToArray(); Write(); Sync.Run(level);
            m.nodes=savedRecords.Skip(1).ToArray(); Write(); Sync.Run(level); Check(n!=null && n.transform.parent==level.transform && p.overridden,"removed source group retains override outside Orphaned");
            m.nodes=new[]{groupRecord}.Concat(savedRecords).ToArray(); Write(); Sync.Run(level); Check(n.transform.parent.GetComponent<OrlaNode>().id=="group" && !level.movedInUnity.Contains(n.gameObject),"restored source group rebinds retained override without artificial drift");
            // Clear on missing sources allows normal removal on next Sync, while user children survive.
            var doomed=second.GetComponent<OrlaPlacement>(); m.nodes=m.nodes.Where(r=>r.id!="npc1").ToArray(); Write(); Sync.Run(level); Placements.Set(second,null,true); Sync.Run(level); Check(second==null,"clearing missing-source override permits ordinary removal");
            // Type change requires explicit Clear, then retains the stable gameplay reference target.
            var ownRecord=m.nodes.First(r=>r.id==third.id); Placements.Set(third,guard); ownRecord.type="group"; ownRecord.rev="convert"; Write(); Sync.Run(level); Placements.Set(third,null,true); Sync.Run(level);
            Check(third.type=="group" && third.GetComponent<OrlaPlacement>()==null && joint.connectedBody==body,"Clear after source type change resumes conversion and preserves parent references");
            m.nodes=m.nodes.Where(r=>r.id!=third.id).ToArray(); Write(); Sync.Run(level);
            var originalRecords=m.nodes;
            m.nodes=m.nodes.Concat(new[]{new NodeRecord{id="source-copy",type="instance",entity="other",scale=1,rev="source-copy"}}).ToArray(); Write(); Sync.Run(level);
            var sourceCopy=Node(level,"source-copy"); Check(!sourceCopy.GetComponent<OrlaPlacement>().overridden,"new source node ID does not copy another placement override");
            m.nodes=originalRecords; Write(); Sync.Run(level);
            // Array items keep their existing mapping/removal behavior, with no node override support.
            var saved=m.nodes; m.nodes=m.nodes.Concat(new[]{new NodeRecord{id="array/0",type="item",entity="npc",scale=1,rev="item"}}).ToArray(); Write(); Sync.Run(level);
            var item=level.GetComponentsInChildren<OrlaNode>(true).First(x=>x.id=="array/0"); Reject(()=>Placements.Set(item,guard),"array-item override is explicitly ineligible");
            mappings.entities[0].prefab=guard; Write(); Sync.Run(level); item=level.GetComponentsInChildren<OrlaNode>(true).First(x=>x.id=="array/0");
            Check(PrefabUtility.GetCorrespondingObjectFromSource(item.gameObject)==guard,"array-item global mapping still replaces its prefab");
            m.nodes=saved; Write(); Sync.Run(level); Check(item==null,"array-item ordinary deletion remains supported");
            // Missing override destination with no representation uses blockout and remains an invalid exception.
            OrlaNode fallback;
            m.nodes=m.nodes.Concat(new[]{new NodeRecord{id="fallback",type="instance",entity="other",scale=1,rev="fallback"}}).ToArray(); Write(); Sync.Run(level); fallback=Node(level,"fallback");
            var fallbackPlacement=fallback.GetComponent<OrlaPlacement>(); Placements.Set(fallback,guard);
            UnityEngine.Object.DestroyImmediate(fallbackPlacement.managedChild); fallbackPlacement.replacement.prefab=null; Sync.Run(level);
            Check(fallbackPlacement.overridden && fallbackPlacement.managedChild!=null && fallbackPlacement.managedChild.GetComponent<OrlaNode>().type=="entity" && fallbackPlacement.problem.Contains("missing"),"missing override without prior content falls back to generated blockout");
            Placements.Set(fallback,null,true); Check(!fallbackPlacement.overridden && fallbackPlacement.managedChild.GetComponent<OrlaNode>().type=="entity","Clear without global entity mapping restores generated blockout");
            EditorUtility.SetDirty(mappings); AssetDatabase.SaveAssets(); EditorSceneManager.SaveScene(level.gameObject.scene,"Assets/PlacementFixture/NPCs.unity");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single); EditorSceneManager.OpenScene("Assets/PlacementFixture/NPCs.unity");
            level=UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Include).First(l=>l.name!="Duplicated Level"); n=Node(level,"npc0"); p=n.GetComponent<OrlaPlacement>();
            Check(p.overridden && p.managedChild!=null && !Placements.Edited(p),"save/reopen preserves serialized settings managed refs and baseline");
            Check(UnityEngine.Object.FindObjectsByType<FixedJoint>(FindObjectsInactive.Include).Single().connectedBody==n.GetComponent<Rigidbody>(),"serialized gameplay reference survives save/reopen");
            Sync.Run(level); Check(string.IsNullOrEmpty(p.problem),"post-reload unchanged Sync retains valid override");
            SessionState.SetInt("Orla18PendingReload",checks);
            EditorUtility.RequestScriptReload();
        }
        catch(Exception e) { Debug.LogException(e); File.WriteAllText(Path.Combine(Root,"placement-result.json"),"FAILED after "+checks+": "+e); EditorApplication.Exit(1); }
    }
    [InitializeOnLoadMethod]
    static void Reloaded()
    {
        var pending=SessionState.GetInt("Orla18PendingReload",0);
        if(pending==0) return;
        SessionState.EraseInt("Orla18PendingReload"); checks=pending;
        EditorApplication.delayCall += AfterReload;
    }
    static OrlaLevel autoLevel;
    static double deadline;
    static void AfterReload()
    {
        try
        {
            autoLevel=UnityEngine.Object.FindObjectsByType<OrlaLevel>(FindObjectsInactive.Include).First(l=>l.name!="Duplicated Level");
            var n=Node(autoLevel,"npc0"); var p=n.GetComponent<OrlaPlacement>();
            Check(p.overridden && Is(p,AssetDatabase.LoadAssetAtPath<GameObject>("Assets/PlacementFixture/Merchant.prefab")) && !Placements.Edited(p),"real script domain reload preserves override references and baseline");
            folder=autoLevel.folder; m=Manifest.Read(folder); autoLevel.autoSync=true;
            m.nodes.First(r=>r.id==n.id).position=new float[]{81,2,3}; m.nodes.First(r=>r.id==n.id).rev="auto";
            m.exportId++; Write(); File.SetLastWriteTimeUtc(Path.Combine(folder,"level.json"),DateTime.UtcNow.AddSeconds(3));
            deadline=EditorApplication.timeSinceStartup+15; EditorApplication.update+=AutoResult;
        }
        catch(Exception e) { Debug.LogException(e); File.WriteAllText(Path.Combine(Root,"placement-result.json"),"RELOAD FAILED: "+e); EditorApplication.Exit(1); }
    }
    static void AutoResult()
    {
        try
        {
            if(autoLevel.exportId!=m.exportId) { if(EditorApplication.timeSinceStartup>deadline) throw new Exception("Auto sync timeout"); return; }
            EditorApplication.update-=AutoResult;
            var n=Node(autoLevel,"npc0"); Check(n.transform.localPosition==new Vector3(81,2,3) && n.GetComponent<OrlaPlacement>().overridden,"real export-driven Auto sync moves overridden NPC after domain reload");
            File.WriteAllText(Path.Combine(Root,"placement-result.json"),$"{{\"passed\":true,\"checks\":{checks}}}"); EditorApplication.Exit(0);
        }
        catch(Exception e) { EditorApplication.update-=AutoResult; Debug.LogException(e); File.WriteAllText(Path.Combine(Root,"placement-result.json"),"AUTO FAILED: "+e); EditorApplication.Exit(1); }
    }
}
