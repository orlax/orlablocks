"""Install a temporary local profile adapter; remove before final checks/commit.
python3 scripts/install-performance-harness.py [remove]
"""
import sys
from pathlib import Path
p=Path('src/web/Viewport.tsx')
s=p.read_text()
profiled = ['cutters', 'expandNodes', 'expandShapes', 'splitInstanced']
for name in profiled:
 s=s.replace(name+' as unprofiled_'+name, name)
s=s.replace('const floor = measureSection("walk-floor-ray", () => floorAt(scene, pose.feet));', 'const floor = floorAt(scene, pose.feet);')
s=s.replace('      recordStatsFrame(pacing.snapshot(), capture.epoch, eligible);\n', '')
start='// BEGIN TEMPORARY PERFORMANCE HARNESS\n'
end='// END TEMPORARY PERFORMANCE HARNESS\n'
while start in s:
 a=s.index(start); b=s.index(end,a)+len(end); s=s[:a]+s[b:]
s=s.replace('        {/* TEMP PROFILE */}<PerformanceHarness api={profileApi} />\n','')
if 'remove' not in sys.argv:
 for name in profiled:
  s=s.replace('{ '+name+',', '{ '+name+' as unprofiled_'+name+',').replace(', '+name+',', ', '+name+' as unprofiled_'+name+',').replace('{ '+name+' }', '{ '+name+' as unprofiled_'+name+' }')
 wrappers=''.join('const '+name+': typeof unprofiled_'+name+' = (...args) => measureSection("'+name+'", () => unprofiled_'+name+'(...args));\n' for name in profiled)
 s=start+'import { PerformanceHarness, measureSection, recordStatsFrame } from "../../scripts/performance-harness";\n'+wrappers+end+s
 s=s.replace('const floor = floorAt(scene, pose.feet);', 'const floor = measureSection("walk-floor-ray", () => floorAt(scene, pose.feet));')
 s=s.replace('      pacing.frame(t0, eligible && isActive.current(), inputEpoch.current);', '      pacing.frame(t0, eligible && isActive.current(), inputEpoch.current);\n      recordStatsFrame(pacing.snapshot(), capture.epoch, eligible);')
 block='''  const profileBaseline = useRef<CameraState | null>(null);
  const profileOriginal = useRef<CameraState | null>(null);
  const profileApi = {
    inspect() {
      const size={width:wrap.current!.clientWidth,height:wrap.current!.clientHeight};
      const before=performance.now();
      const firstPick=pickWithTerrain(screenRay(cam.current,size,size.width/2,size.height/2),pickable);
      const firstPickMs=performance.now()-before;
      return { firstPickMs, firstPick:firstPick?.id, cursor:cursorRef.current, hoveredId, selection, gizmo, selectable:selectable.map(s=>s.id), cuts: [...cuts].map(([id, holes]) => [id, holes.map(h => h.id)]), drawn: drawn.map(s => {
        const b=boundsOf([s]);
        return {id:s.id,type:s.type,...(s.type === "box" ? {x:s.x,height:s.height} : {}),screen:worldToScreen(cam.current,size,{x:(b.minX+b.maxX)/2,y:b.maxY,z:(b.minZ+b.maxZ)/2})};
      }), terrainPreviewActive };
    },
    capture() { return runCapture(editorView(cam.current), 800, 600, 1, {notes:true,lines:true}); },
    prepare() {
      profileOriginal.current = { ...cam.current, focus: { ...cam.current.focus } };
      if (new URLSearchParams(location.search).get("reference") === "castle-17.1") {
        cam.current = {focus:{x:5.45,z:-61.7},yaw:135.46,distance:276.86};
      }
      profileBaseline.current = { ...cam.current, focus: { ...cam.current.focus } };
      const el = wrap.current!;
      const hit = pickHit(screenRay(cam.current, {width:el.clientWidth,height:el.clientHeight}, el.clientWidth/2, el.clientHeight/2), pickable);
      return { camera: profileBaseline.current, walkStart: hit?.point ?? {x:0,y:0,z:20} };
    },
    begin(route: string) {
      const castle = new URLSearchParams(location.search).has("castle");
      cam.current = castle && profileBaseline.current ? { ...profileBaseline.current, focus: {...profileBaseline.current.focus} } : { focus: { x: 0, z: 0 }, yaw: 45, distance: 150 };
      if (route === "rotation") yawKeys.current.add("right");
      if (route === "pan") {
        const size = { width: wrap.current!.clientWidth, height: wrap.current!.clientHeight };
        pan.current = { pointerId: 999, grabbed: screenToGround(cam.current, size, size.width/2, size.height/2), sx: size.width/2, sy: size.height/2 };
      }
      if (route === "walk") {
        const el = wrap.current!;
        const hit = castle ? pickHit(screenRay(cam.current, {width:el.clientWidth,height:el.clientHeight}, el.clientWidth/2, el.clientHeight/2), pickable) : null;
        startWalk(hit?.point ?? {x:0,y:0,z:20}, {paused:true,yaw:0,preset:"first"});
      }
      invalidate();
    },
    tick(route: string, elapsed: number) {
      const el=wrap.current!, rect=el.getBoundingClientRect();
      if (route === "pan" || route === "hover") onPointerMove({clientX:rect.left+rect.width/2+Math.sin(elapsed/500)*120,clientY:rect.top+rect.height/2, pointerId:999, currentTarget:el, target:el, shiftKey:false,ctrlKey:false,metaKey:false,altKey:false} as unknown as PointerEvent);
      if (route === "zoom") el.dispatchEvent(new WheelEvent("wheel", {deltaY:Math.cos(elapsed/500)*3,bubbles:true,cancelable:true}));
      if (route === "walk" && live.current && walkRef.current) {
        live.current.flight=null; live.current.keys.forward=true; live.current.pose.yaw=Math.sin(elapsed/1000)*15;
        if(walkRef.current.phase!=="walking") setWalk({...walkRef.current,phase:"walking"});
        invalidate();
      }
    },
    end(route: string) {
      pan.current=null; yawKeys.current.clear();
      if(route === "walk") finishWalk({width:wrap.current!.clientWidth,height:wrap.current!.clientHeight});
      if (profileOriginal.current && new URLSearchParams(location.search).has("castle")) {
        cam.current = {...profileOriginal.current, focus:{...profileOriginal.current.focus}};
        onViewChangeRef.current(viewOf(cam.current, {width:wrap.current!.clientWidth,height:wrap.current!.clientHeight}), cam.current);
      }
      invalidate();
    }
  };
'''
 s=s.replace('  const start = cameraPosition(cam.current);', start+block+end+'  const start = cameraPosition(cam.current);')
 s=s.replace('        <CompassSync cam={cam} rose={rose} />','        {/* TEMP PROFILE */}<PerformanceHarness api={profileApi} />\n        <CompassSync cam={cam} rose={rose} />')
p.write_text(s)

main=Path('src/web/main.tsx')
m=main.read_text().replace('import { Profiler } from "react";\nimport { recordCommit } from "../../scripts/performance-harness";\n','').replace('<Profiler id="editor" onRender={recordCommit}><App /></Profiler>', '<App />')
if 'remove' not in sys.argv:
 m='import { Profiler } from "react";\nimport { recordCommit } from "../../scripts/performance-harness";\n'+m
 m=m.replace('<App />','<Profiler id="editor" onRender={recordCommit}><App /></Profiler>')
main.write_text(m)
