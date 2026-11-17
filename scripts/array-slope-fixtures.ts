/** Ephemeral store/export only. No configured scene storage is opened. */
import fs from "node:fs";
import path from "node:path";
import { createSceneStore } from "../src/server/scene";
import { exportScene } from "../src/server/export";
import { setDefinitions } from "../src/shared/entities";
import { EMPTY_LIBRARY } from "../src/shared/library";
const root = process.argv[2];
if (!root || !path.resolve(root).startsWith("/private/tmp/")) throw new Error("Scratch export required");
fs.mkdirSync(root, { recursive:true });
setDefinitions({rail:[{id:"box_1",type:"box",kind:"volume",x:0,y:0,z:0,width:2,depth:0.2,height:0.2,rotation:0,color:"blue",createdBy:"human"}]});
const store = createSceneStore();
store.drawShapes([
  {type:"array",name:"Uphill",entity:"rail",layout:{type:"path",slope:true,count:3,points:[{x:0,y:0,z:0},{x:4,y:3,z:0}]}},
  {type:"array",name:"Downhill",entity:"rail",layout:{type:"path",slope:true,count:3,points:[{x:0,y:6,z:5},{x:4,y:3,z:5}]}},
  {type:"array",name:"Upright legacy",entity:"rail",layout:{type:"path",count:3,points:[{x:0,y:0,z:10},{x:4,y:3,z:10}]}},
  {type:"array",name:"Vertical",entity:"rail",layout:{type:"path",slope:true,count:3,points:[{x:10,y:0,z:0},{x:10,y:4,z:0}]}},
  {type:"array",name:"Circle spacing",entity:"rail",skip:[1],layout:{type:"circle",x:20,z:0,radius:4,sweep:101,rise:4,spacing:1.95}},
  {type:"array",name:"Curved slope",entity:"rail",pitch:15,roll:-10,rotation:20,layout:{type:"path",slope:true,count:5,points:[{x:0,y:0,z:20,out:{x:3,y:1,z:0}},{x:5,y:4,z:16,in:{x:0,y:-1,z:3}}]}},
],"human");
await exportScene({dir:root,seq:1,project:{id:"array19",name:"Arrays 19.5",description:""},scene:{id:"s",name:"Slopes"},nodes:store.getScene().nodes,library:{...EMPTY_LIBRARY,entities:[{id:"rail",name:"Rail",tags:[]}]}});
console.log(root);
