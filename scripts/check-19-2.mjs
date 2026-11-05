// Scratch-only browser fixture for localized hover and one-shot outliner reveal.
import { connect } from './check-client.mjs';
const port = Number(process.argv[2] ?? 5171);
const count = Number(process.argv[3] ?? 80);
if (!Number.isInteger(count) || count < 1 || count > 2000) throw new Error('Use 1–2000 blocks');
const columns = count > 80 ? Math.ceil(Math.sqrt(count)) : 10;
const session = await connect(port, {project:`19.2 hover/reveal ${Date.now()}`});
try {
  await session.call('get_scene');
  await session.call('get_guide',{topic:'design'});
  const result = await session.call('draw_shapes', {shapes:[
    {type:'group',ref:'building',name:'Nested building'},
    {type:'group',ref:'floor',parent:'$building',name:'Upper floor'},
    ...Array.from({length:count},(_,i)=>({type:'box',name:`Block ${i+1}`,parent:'$floor',x:(i%columns)*3-(columns-1)*1.5,z:Math.floor(i/columns)*3-(Math.ceil(count/columns)-1)*1.5,width:2,depth:2,height:1})),
    {type:'instance',ref:'instance',name:'Ordinary human',entity:'human',x:-20,z:0,scale:3},
    {type:'array',ref:'array',name:'Human row',entities:[{entity:'human'}],layout:{type:'grid',x:0,y:0,z:20,columns:5,rows:1,spacing:{x:4,z:4}}},
    {type:'box',ref:'locked',name:'Locked block',x:20,z:0,width:3,depth:3,height:2},
    {type:'box',ref:'hidden',name:'Hidden block',x:20,z:5,width:3,depth:3,height:2},
  ]});
  await session.human.request({type:'update_nodes',changes:[{id:result.refs.locked,locked:true},{id:result.refs.hidden,hidden:true}]},m=>m.type==='scene');
  console.log(JSON.stringify(result.refs));
} finally {await session.close();}
