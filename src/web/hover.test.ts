import { describe, expect, it } from "vitest";
import type { SceneNode } from "../shared/scene.types";
import { selectableAt } from "../shared/tree";
import { ownerOf } from "../shared/entities";
import { hoverTarget, hoverOwnerLabel } from "./hover";

const nodes: SceneNode[] = [
  {type:"group",id:"group_1",name:"Building",createdBy:"human"},
  {type:"group",id:"group_2",name:"Floor",parent:"group_1",createdBy:"human"},
  {type:"box",id:"box_1",parent:"group_2",kind:"volume",x:0,y:0,z:0,width:2,depth:2,height:2,rotation:0,color:"gray",createdBy:"human"},
  {type:"instance",id:"instance_1",name:"Human",parent:"group_2",entity:"human",x:3,y:0,z:0,rotation:0,createdBy:"human"},
];

describe("localized hover and click ownership", () => {
  it("highlights the hit shape while click ownership follows entered groups", () => {
    expect(hoverTarget("box_1")).toBe("box_1");
    expect(selectableAt(nodes,"box_1",null)).toBe("group_1");
    expect(hoverOwnerLabel(nodes,null,"box_1",null,false)).toBe("Building");
    expect(hoverOwnerLabel(nodes,null,"box_1","group_1",false)).toBe("Building › Floor");
    expect(hoverOwnerLabel(nodes,null,"box_1","group_2",false)).toBe("Building › Floor › box_1");
  });
  it("keeps multipart instance hover together without highlighting sibling placements", () => {
    expect(hoverTarget("instance_1/box_1")).toBe("instance_1");
    expect(hoverOwnerLabel(nodes,null,hoverTarget("instance_1/box_1"),"group_2",false)).toBe("Building › Floor › Human");
    expect(hoverOwnerLabel(nodes,null,"instance_1",null,true)).toBe("Building › Floor › Human");
  });
  it("keeps array part identity localized and preserves array click ownership", () => {
    const part = "array_1/12/box_1";
    expect(hoverTarget(part)).toBe(part);
    expect(ownerOf(hoverTarget(part))).toBe("array_1");
  });
  it("labels an outliner target and clears empty hover", () => {
    expect(hoverOwnerLabel(nodes,"group_2","box_1",null,false)).toBe("Building › Floor");
    expect(hoverOwnerLabel(nodes,null,null,null,false)).toBeNull();
  });
});
