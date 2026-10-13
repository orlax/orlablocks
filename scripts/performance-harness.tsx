// Temporary local instrumentation. Install/remove with install-performance-harness.py.
import { useEffect, useRef } from 'react';
import { useThree, invalidate } from '@react-three/fiber';
let commits: number[] = [];
let sectionAfter = Infinity;
let sections: Record<string, number[]> = {};
let boundaryFrames: any[] | null = null;
export function recordStatsFrame(navigation: any, epoch: number, eligible: boolean) {
  boundaryFrames?.push({navigation, epoch, eligible});
}
export function measureSection<T>(name: string, run: () => T): T {
  if (performance.now() < sectionAfter) return run();
  const start = performance.now();
  try { return run(); } finally { (sections[name] ??= []).push(performance.now() - start); }
}
export function recordCommit(_id: string, _phase: string, duration: number) { commits.push(duration); }
export function PerformanceHarness({ api }: { api: any }) {
  const latest = useRef(api); latest.current = api;
  const gl = useThree(s => s.gl);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    // Main-server profiling is opt-in and uses only navigation, never fixture/scene edits.
    if (!params.has('profile') || (location.port === '5170' && !params.has('castle'))) return;
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:45px;left:20px;z-index:9999;background:white;color:black;padding:8px;max-height:200px;overflow:auto';
    const button = document.createElement('button'); button.textContent = 'Run navigation baseline';
    const out = document.createElement('pre'); out.id = 'performance-results'; panel.append(button, out); document.body.append(panel);
    const boundaryButton = document.createElement('button'); boundaryButton.textContent = 'Check navigation boundaries'; panel.append(boundaryButton);
    const boundaryOut = document.createElement('pre'); boundaryOut.id = 'performance-boundaries'; panel.append(boundaryOut);
    const inspectButton = document.createElement('button'); inspectButton.textContent = 'Inspect derived scene'; panel.append(inspectButton);
    const inspectOut = document.createElement('pre'); inspectOut.id = 'performance-scene'; panel.append(inspectOut);
    inspectButton.onclick = () => { inspectOut.textContent = JSON.stringify(latest.current.inspect()); };
    let rows: any[] = [], active: any = null, frames = 0;
    const original = gl.render;
    gl.render = function(scene, camera) {
      const t = performance.now(); original.call(gl, scene, camera); frames++;
      if (active && t > active.after) {
        if (active.last) active.intervals.push(t - active.last);
        active.last = t; active.cpu.push(performance.now() - t); active.calls.push(gl.info.render.calls);
      }
    };
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const summary = (a: number[]) => { const s = [...a].sort((a,b)=>a-b); return {mean:a.reduce((a,b)=>a+b,0)/a.length, median:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],n:a.length}; };
    boundaryButton.onclick = async () => {
      if (!document.querySelector('.stats-readout') || button.disabled) return;
      boundaryButton.disabled = true; button.disabled = true;
      latest.current.prepare(); boundaryFrames = [];
      const visibility: any[] = [];
      const changed = () => visibility.push({state:document.visibilityState,frame:boundaryFrames!.length});
      document.addEventListener('visibilitychange', changed);
      const read = () => document.querySelector('.stats-readout')?.textContent;
      try {
        latest.current.begin('rotation'); await sleep(5000); const moving = read();
        latest.current.end('rotation'); await sleep(900); const idle = read();
        latest.current.begin('rotation'); await sleep(1500); const resumed = read();
        const before = performance.now(); await latest.current.capture(); const captureMs = performance.now() - before;
        await sleep(700); const afterCapture = read(); latest.current.end('rotation');
        await sleep(900);
        const epochs = [...new Set(boundaryFrames!.map(f=>f.epoch))];
        boundaryOut.textContent = JSON.stringify({moving,idle,resumed,afterCapture,finalIdle:read(),captureMs,epochs,firstByEpoch:epochs.map(epoch=>boundaryFrames!.find(f=>f.epoch===epoch)),visibility:visibility.map(v=>({...v,nextFrame:boundaryFrames![v.frame]})),frameCount:boundaryFrames!.length});
      } finally {document.removeEventListener('visibilitychange', changed);boundaryFrames=null; latest.current.end('rotation'); boundaryButton.disabled=false;button.disabled=false;}
    };
    button.onclick = async () => {
      button.disabled = true; rows = [];
      const dpr = gl.getPixelRatio(), shadows = gl.shadowMap.enabled;
      const meta = {ua:navigator.userAgent, dpr, canvas:[gl.domElement.clientWidth,gl.domElement.clientHeight], stats:!!document.querySelector('.stats-readout'), entitiesCollapsed:!!document.querySelector('.entities-panel.collapsed'), reference:latest.current.prepare()};
      try {
        const requested = params.get('quality');
        for (const quality of (requested && ['default','no-shadows','dpr2'].includes(requested) ? [requested] : ['default','no-shadows','dpr2'])) {
          gl.shadowMap.enabled = quality !== 'no-shadows' && shadows; gl.setPixelRatio(quality === 'dpr2' ? 2 : dpr);
          for (const route of ['rotation','pan','zoom','hover','walk']) for (let trial=1;trial<=3;trial++) {
            latest.current.begin(route); await sleep(500);
            active = {after:performance.now()+1000, last:0, intervals:[],cpu:[],calls:[]};
            sections = {}; sectionAfter = active.after;
            commits = [];
            const input: number[] = []; const start=performance.now();
            await new Promise<void>(resolve => {
              const step=() => { const t=performance.now(), elapsed=t-start;
                const before=performance.now(); latest.current.tick(route, elapsed); input.push(performance.now()-before);
                if(elapsed<3000) requestAnimationFrame(step); else resolve();
              }; requestAnimationFrame(step);
            });
            const result = active; active=null; sectionAfter = Infinity; latest.current.end(route);
            rows.push({quality,route,trial,interval:summary(result.intervals),cpu:summary(result.cpu),input:summary(input),calls:summary(result.calls),react:summary(commits),sections:Object.fromEntries(Object.entries(sections).map(([name,times])=>[name,summary(times)]))});
            out.textContent=JSON.stringify({meta,rows}); await sleep(350);
          }
        }
        await sleep(1000); const before=frames; await sleep(1000);
        out.textContent=JSON.stringify({meta,rows,idleFrames:frames-before});
      } finally {gl.shadowMap.enabled=shadows;gl.setPixelRatio(dpr);button.disabled=false;invalidate();}
    };
    return () => {gl.render=original;panel.remove();};
  }, [gl]);
  return null;
}
