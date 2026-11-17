// Real protocol/browser fixture. Spare server + scratch DATA_DIR only.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connect } from './check-client.mjs';
const port = Number(process.argv[2] ?? 5174);
const session = await connect(port, {project:`19.5 arrays ${Date.now()}`});
const {call,human,opened} = session;
const client = new Client({name:'array-schema-check',version:'1'});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  assert.equal(client.getServerVersion().version,'0.0.48');
  const {tools} = await client.listTools();
  const schema = JSON.stringify(tools.find(t=>t.name==='draw_shapes').inputSchema);
  assert(schema.includes('slope') && schema.includes('Maximum centerline spacing'));
  await call('get_guide',{topic:'design'});
  await call('define_entity',{name:'rail',shapes:[{x:0,z:0,width:1.6,depth:0.15,height:0.3}]});
  const made = await call('draw_shapes',{shapes:[
    {type:'group',ref:'g',name:'Slopes'},
    {type:'line',ref:'line',parent:'$g',name:'Rising route',points:[{x:0,y:0,z:0},{x:8,y:6,z:0},{x:12,y:8,z:-4}]},
    {type:'array',ref:'a',parent:'$g',name:'Slope railings',entity:'rail',layout:{type:'path',along:{id:'$line'},spacing:1.8,slope:true},skip:[2]},
    {type:'array',ref:'old',name:'Upright comparison',entity:'rail',layout:{type:'path',count:6,points:[{x:0,y:0,z:4},{x:8,y:6,z:4}]}},
    {type:'array',ref:'circle',name:'Circle spacing',entity:'rail',layout:{type:'circle',x:22,z:0,radius:4,sweep:101,rise:4,spacing:1.95}},
    {type:'box',ref:'support',x:30,z:0,width:2,depth:2},
  ]});
  const r=made.refs;
  const circles=(await call('get_scene',{ids:[r.circle]})).nodes[0];
  assert.equal(circles.requestedItems,6); assert(circles.fittedSpacing<=1.95);
  for(const patch of [{facing:'fixed'},{on:{id:r.support}}]){
    const before=(await call('get_scene',{full:true})).nodes;
    const bad=await call('update_nodes',{changes:[{id:r.line,name:'invalid'},{id:r.a,...patch}]},{allowError:true});
    assert.match(bad.error,/slope/); assert.deepEqual((await call('get_scene',{full:true})).nodes,before);
  }
  const before=(await call('get_scene',{ids:[r.circle]})).nodes;
  await call('update_nodes',{changes:[{id:r.circle,layout:{count:4}}]});
  assert.equal((await call('get_scene',{ids:[r.circle]})).nodes[0].items,4);
  await human.request({type:'undo'},m=>m.type==='scene');
  assert.deepEqual((await call('get_scene',{ids:[r.circle]})).nodes,before);
  const original=(await call('get_scene',{ids:[r.a],full:true})).nodes[0];
  await call('update_nodes',{changes:[{id:r.line,points:[{x:0,y:0,z:0},{x:8,y:2,z:0},{x:12,y:3,z:-4}]}]});
  assert.notDeepEqual((await call('get_scene',{ids:[r.a],full:true})).nodes[0],original);
  await human.request({type:'undo'},m=>m.type==='scene');
  assert.deepEqual((await call('get_scene',{ids:[r.a],full:true})).nodes[0],original);
  await call('move_nodes',{ids:[r.g],dx:0,dz:-12,dy:0,copy:true});
  const all=(await call('get_scene',{full:true})).nodes;
  const copied=all.find(n=>n.type==='array'&&n.id!==r.a&&n.layout?.slope);
  assert(copied.layout.along.id!==r.line); assert(all.some(n=>n.id===copied.layout.along.id));
  const saved=all;
  await human.request({type:'open_scene',project:opened.project.id,scene:opened.scene.id},m=>m.type==='opened'&&m.open?.scene.id===opened.scene.id);
  assert.deepEqual((await call('get_scene',{full:true})).nodes,saved);
  console.log(JSON.stringify({ok:true,refs:r,project:opened.project.id,scene:opened.scene.id}));
} finally {await client.close();await session.close();}
