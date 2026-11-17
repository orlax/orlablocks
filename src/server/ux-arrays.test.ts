import { beforeEach, describe, it, expect } from "vitest";
import { arrayItems } from "../shared/arrays";
import { setDefinitions } from "../shared/entities";
import { NodeSchema, type ArrayNode } from "../shared/scene.types";
import { createSceneStore } from "./scene";
const block = { id:"box_1", type:"box", kind:"volume", x:0, y:0, z:0, width:2, depth:0.2, height:0.2, rotation:0, color:"gray", createdBy:"human" } as const;
beforeEach(() => setDefinitions({ rail:[block] }));
describe("19.5 atomic array edits", () => {
  it("switches count/spacing, preserves skips and validates stored modes", () => {
    const store = createSceneStore();
    const [a] = store.drawShapes([{type:"array",entity:"rail",skip:[1],layout:{type:"circle",x:0,z:0,radius:4,count:8}}],"agent");
    const before = structuredClone(store.getScene().nodes);
    store.updateNodes([{id:a.id,layout:{spacing:2}}],"agent");
    const changed = store.getScene().nodes[0] as ArrayNode;
    expect(changed).toMatchObject({layout:{place:"spacing",spacing:2},skip:[1]});
    expect(changed.layout).not.toHaveProperty("count");
    expect(NodeSchema.parse(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
    store.undo(); expect(store.getScene().nodes).toEqual(before);
    store.redo(); expect(store.getScene().nodes[0]).toEqual(changed);
    store.updateNodes([{id:a.id,layout:{count:4}}],"agent");
    expect((store.getScene().nodes[0] as ArrayNode).layout).toEqual({type:"circle",x:0,y:0,z:0,radius:4,count:4});
    for (const layout of [{type:"circle" as const,x:0,z:0,radius:4}, {type:"circle" as const,x:0,z:0,radius:4,place:"spacing" as const}]) {
      expect(() => store.drawShapes([{type:"array",entity:"rail",layout}],"agent")).toThrow();
    }
  });
  it("rejects slope conflicts atomically and refreshes slope along dependencies in one undo step", () => {
    const store = createSceneStore();
    const [line,a] = store.drawShapes([
      {type:"line",ref:"route",points:[{x:0,y:0,z:0},{x:4,y:3,z:0}]},
      {type:"array",entity:"rail",layout:{type:"path",along:{id:"$route"},slope:true,count:3}},
    ],"agent");
    const before = structuredClone(store.getScene().nodes);
    expect(arrayItems(a as ArrayNode)[0].roll).toBeCloseTo(36.87,2);
    for (const fields of [{on:{id:line.id}},{facing:"fixed" as const},{facing:"random" as const}]) {
      expect(() => store.updateNodes([{id:line.id,name:"no"},{id:a.id,...fields}],"agent")).toThrow(/slope|nothing stands/);
      expect(store.getScene().nodes).toEqual(before);
    }
    store.updateNodes([{id:line.id,points:[{x:0,y:0,z:0},{x:4,y:-3,z:0}]}],"agent");
    expect(arrayItems(store.getScene().nodes[1] as ArrayNode)[0].roll).toBeCloseTo(-36.87,2);
    store.undo(); expect(store.getScene().nodes).toEqual(before);
    store.updateNodes([{id:a.id,layout:{slope:false},facing:"fixed"}],"agent");
    expect((store.getScene().nodes[1] as ArrayNode).layout).not.toHaveProperty("slope");
  });
});
