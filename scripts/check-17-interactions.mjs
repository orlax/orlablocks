// Scratch-only regression fixture/actions. Scene operations use editor WebSocket/MCP APIs.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connect, openHuman } from './check-client.mjs';
import fs from 'node:fs';
const port = Number(process.argv[2] ?? 5171), action = process.argv[3] ?? 'setup';
if (port === 5170) throw new Error('Scratch servers only');
if (action === 'setup') {
  const session = await connect(port, {project:`Editor 17.2 checks ${Date.now()}`});
  try {
    await session.call('get_scene'); await session.call('get_guide',{topic:'design'});
    const made = await session.call('draw_shapes',{shapes:[
      {type:'group',ref:'room',name:'Test room'},
      {type:'box',ref:'body',name:'Room body',kind:'room',parent:'$room',x:0,z:0,width:16,depth:16,height:4},
      {type:'box',ref:'hole',name:'Floor hole',kind:'hole',parent:'$room',x:0,z:0,y:-1,width:4,depth:4,height:3},
      {type:'box',ref:'prop',name:'Movable prop',kind:'volume',x:12,z:0,width:3,depth:3,height:3},
      {type:'box',ref:'locked',name:'Locked prop',kind:'volume',x:12,z:8,width:3,depth:3,height:3},
      {type:'box',ref:'hidden',name:'Hidden prop',kind:'volume',x:-12,z:8,width:3,depth:3,height:3},
      {type:'ramp',name:'Curved ramp',width:3,points:[{x:-12,y:0,z:-8,out:{x:4,z:0}},{x:8,y:4,z:-12,in:{x:-4,z:0}}]},
      {type:'freeform',name:'Curved outline',kind:'volume',height:2,points:[{x:-18,z:0,out:{x:0,z:3}},{x:-18,z:8},{x:-14,z:8},{x:-14,z:0}]},
      {type:'instance',name:'Scaled human',entity:'human',x:8,z:8,scale:2,rotation:30,pitch:10},
      {type:'array',name:'Human row',entities:[{entity:'human'}],layout:{type:'grid',x:0,y:0,z:14,columns:4,rows:1,spacing:{x:3,z:3}}},
    ]});
    await session.human.request({type:'update_nodes',changes:[{id:made.refs.locked,locked:true},{id:made.refs.hidden,hidden:true}]},m=>m.type==='scene');
    fs.writeFileSync('/private/tmp/orlablocks-17-2-refs.json',JSON.stringify(made.refs));
    console.log(JSON.stringify(made.refs));
  } finally {await session.close();}
} else {
  const human = await openHuman(port);
  human.send({type:"tab",visible:false,focused:false});
  try {
    if (action === 'interaction-scene') {
      const projects=await human.wait(m=>m.type==='projects');
      const project=projects.projects.filter(p=>p.name.startsWith('Editor 17.2 checks')).sort((a,b)=>b.name.localeCompare(a.name))[0];
      await human.request({type:'open_scene',project:project.id,scene:'main'},m=>m.type==='opened');
    } else if (action === 'undo' || action === 'redo') await human.request({type:action},m=>m.type==='scene');
    else if (action === 'definition-undo') {
      await human.request({type:'open_entity',entity:'human'},m=>m.type==='opened'&&m.open?.entity);
      await human.request({type:'undo'},m=>m.type==='scene');
      await human.request({type:'close_entity'},m=>m.type==='opened'&&!m.open?.entity);
    } else if (action === 'definition') {
      await human.request({type:'update_nodes',changes:[{id:'box_1',height:1}]},m=>m.type==='scene');
    } else if (action === 'move-hole') {
      const refs=JSON.parse(fs.readFileSync('/private/tmp/orlablocks-17-2-refs.json','utf8'));
      await human.request({type:'update_nodes',changes:[{id:refs.hole,x:30}]},m=>m.type==='scene');
    } else if (action === 'capture') {
      const client=new Client({name:'17.2-capture',version:'1'});
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      try {
        const r=await client.callTool({name:'render_view',arguments:{view:'plan',size:640}});
        if(r.isError) throw new Error(JSON.stringify(r));
        const img=r.content.find(c=>c.type==='image');
        const path=process.argv[4] ?? '/private/tmp/orlablocks-17-2-capture.png';
        fs.writeFileSync(path,Buffer.from(img.data,'base64')); console.log(path);
      } finally {await client.close();}
    } else throw new Error('Unknown action');
  } finally {human.close();}
}
