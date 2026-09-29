our last phase 13 with Agent ergonomics is now completed, we are now gonna plan a new batch of improvements to the tool based on todays work with it. 


things the human wants based on their own use: 

- a 3D cursor so I can see where my mouse is pointing can be a small sphere or something that sits on the scene where my cursor is pointing. 
- BUG I tried to draw on the top of a box with some tapper/bevels applied to it and I could not. 
- using a second browser window seems usefull but because of how the capture flow is setup it is hard to "unlock" my mouse I had to quickly pres esc and enter and rely on chrome not allowing my mouse to be re-capture, I think this should be supported. 
- the same way I can hide notes, be able to hide the Lines
- designing now very large scenes I am quite limited by the zoom out I would like to make the zoom out limit twice what it is today at least (or unlimited? why do we have a limit) 
- an eval i want to make: me working against an Agent, who is faster? but for this we would need the agent to work on their OWN scene. here is what I am thinking. we need a button called "work with agent" or something that I press on a scene, when I do that is the active scene for the agents. I can go open something else and work on it and the agent continues to work with the scene they were invited to. this way I can do a little design race. 
- we need free form rotation for everything, groups included there is just a lot of value on being able to do that. 
- we need uniform scalling, a way of working that emerged was that i would make a small sketch of my ideas and point that to the agent and then they would replicate the small sketch at the required scale. but even for then and for me, being able to scale something up or down is needed this can be at the node level. so we dont have to do a huge refactor? 


finally I again asked the agent what would have help them in their current session, this is what we go back:

AGENT FEEDBACK: 

Here's my honest read of the session, ordered by impact.

MCP tool changes (biggest wins first)

1. A leak / enclosure check. About a third of my effort went into "is this sealed below the ceiling?": boundary peaks, gorge walls, bowl rim, valley walls, the waterfall chain. I estimated the radii of tapered, rounded shapes at height by hand, and I still shipped 3 leaks and a blocked gorge mouth that I only caught by reading item positions back. Two possible shapes for it:
- check_enclosure({ from: point, y_band: [0,120] }): flood-fill the air from a point and report where it escapes.
- A horizontal slice render (render_view plan, slice_y: 110) showing each solid's outline at that height. Gaps would be visible at a glance.

2. A way to see what the human changed. Between turns you reshaped module A, enlarged a mountain, grew the lake, edited the boundary, and changed valley peak from 200 m to a 143 m dome. I found that last one by accident, after I'd relied on it. A get_changes({ since: my_last_step }) returning a human-edit diff would stop me building on stale assumptions.

3. A path measurement tool. I worked out flight times, climb slopes and clearances by hand on every pass. For example, measure_path(line, { speed: 16, climb_rate: 6, probe_radius: 5 }) could return length, time, steepest segment, places where the 6 m/s climb rate is exceeded, and the tightest clearance with its location. That one call would replace most of my verification arithmetic.

4. Scale on transforms. Both of your sketches needed "copy this, scale 4.5×, rotate/mirror." With a scale option on move_nodes/mirror_nodes (or a transform_copy), I'd have started from your sketch exactly instead of re-deriving it point by point. I lost many tokens there, and made one mirroring judgment call.

5. Facing helpers. I computed ring and stand rotations with atan2 about 40 times. Something like rotation: { toward: point } or { along: line_id } on instances would remove that, along with a class of mistakes.

6. Leaner results. Every get_scene with a root re-sent all ~15 notes in full, and every array create or update echoed up to 40 item lines. Making notes and item lines opt-in would cut a large share of this session's input tokens.

7. Validation that doesn't throw away the batch. The "ramp turns too tightly" error rejected a 30-shape batch twice. A dry_run, or an error that states the minimum turn radius allowed, would avoid the resends.

8. A lint pass. It would flag things like:
- an instance floating well above any surface (my y 122 typo)
- a #boundary-tagged node below the scene ceiling
- an entity whose pivot is off-center (the warnings for 7- and 9-sided cylinders)
- a note that refers to deleted nodes (note 12 still says "between rings 11 and 13", which is stale)

9. The ceiling as a scene setting, not a note. Renders, lint and the enclosure check could then all use it.

My own process mistakes, worth encoding

- I never tried check_sight, which is probably exactly the ring-skip test I did by hand. Future agents should list every tool at the start and ask of each one whether it replaces manual work.
- I asked about constraints too late. Your two-person, 7-month budget reshaped everything, but I learned it after drawing a full design. The first questions should be team size and timeline, art references, and how finished you want the result.
- I defaulted to hard geometry. You had to steer me toward organic shapes twice (gorge → valley, flat ridge → mountains). The guide should state the art direction.
- Your sketches worked best. A small sketch from you plus "scale it up" carried more intent than any text, and it should be the formal workflow.

Skill and guide content to write

- Design guide additions:
  - Art direction: Witch Hat Atelier / Ghibli, organic silhouettes, no long straight walls.
  - The ceiling rule.
  - Sealing rules: overlap at ceiling height, not at the base.
  - The anti-skip rule: the chord from ring n to ring n+2 must pass through solid rock.
- A "flight level" skill: a checklist covering broom metrics, timing targets, the sealing and anti-skip checks, and the reusable entity kit (boundary peak, valley mountain, race kit), with a "render these 4 views after each change" review loop.
- An end-of-session audit step: check notes for staleness, confirm the entities in the library match their descriptions, and sync the doc.

For your prompts

Keep sketching; that was the highest-signal input. Three things would help:
- Put constraints and references up front.
- Say "I edited X" when you've changed shared entities or geometry, until the tool can show me that itself.
- Mark which decisions are yours and which I should just make. You did this implicitly, and I sometimes asked more than I needed to.

If you'd like, I can write the flight-level skill and the design-guide additions now, plus a tool wishlist in docs/orlablocks/ you can use as a spec for the MCP server.