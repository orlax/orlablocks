/**
 * The design guide every project starts with (plan 08 §5B), modeled on ClaudeAnimationBase's ANIMATION_GUIDE.md:
 * goals, rules that serve them, the failures to check against, and a worked example. It's a starting point the
 * human rewrites for their game; the game's facts are left blank, never invented.
 */
export const DEFAULT_GUIDE = `# Design guide

This guide says what a good level is for this game. The tools' own rules (how shapes, holes and ramps work) are in \`get_guide\`'s other topics; this one is about taste. Rewrite any of it: nothing here is final.

**The human decides what to build; this guide decides how.** If they ask for something it advises against, do what they ask, and mention the trade-off once.

## Goals

Every rule below serves one of these.

- **Readable.** The player can tell where to go, what's dangerous and what they can use, from what they see.
- **Paced.** Tension and rest take turns: a challenge, then a breather, a reveal, a shortcut home.
- **Uses the player's kit.** Spaces are built around what the player can do (the skills in the project's library), not around generic obstacles.
- **One piece.** Each room belongs to the level around it: it's reached, it leads on, and it pays off something set up earlier.

## The game's facts

Fill these in. Until they're here, ask before relying on a number.

- Player height: ___ m (the default \`human\` entity is 1.8 m)
- Jump: ___ m up, ___ m across (standing), ___ m across (running)
- Safe drop: ___ m
- Abilities: see the library's skills

### Sizes, for scale

| thing | size |
|---|---|
| person | 1.8 m tall |
| door | about 1 m wide, 2.2 m tall |
| corridor | 2–3 m wide |
| stair step | 0.2–0.25 m high |
| small room | 6–8 m across |
| hall | 15 m or more |

## Principles

- **Model the player.** You know the layout because you built it; the player sees it once, from inside, at eye height. For every beat, ask what the player must notice, from where, and what leads their eye there: light, a landmark, a line of sight, something moving.
- **Telegraph before you gate.** Show a locked door, a high ledge or a skill's target before the player can use it, so the solution is a discovery, not a guess.
- **Loop back.** After a detour, open a shortcut to somewhere the player has been.
- **Restraint.** One well-used idea per room beats three. Leave room to breathe.
- **Contrast.** Vary size, height, light and openness from one space to the next.

## Workflow

- **For a big request, write a short brief first:** the beats in order, what the player needs at each, the skills it uses, the notes it answers. Show it to the human before drawing. It can be sketched in the scene as lines (the path) and named groups.
- **Offer options that differ in structure,** not three versions of one idea.
- **Build in named, described groups,** so the outline reads as the level's plan.
- **Mark the critical path** with a line when you change a route.

## Detail

- **A blockout decides the level, it doesn't decorate it.** Shapes are gameplay space: where the player walks, climbs, hides and looks.
- **Detail where the player's attention is:** a landmark, a goal, the thing a room is about. Elsewhere, plain volumes.
- **Decoration is one shape or one array:** battlements as an array of a merlon entity along the wall top, a roof as one cone. A detail repeated many times is an entity, placed by an array.

## Review

- **A captioned shot is a requirement:** after a change near one, re-check it and say whether its caption still holds.
- **After building something,** a sheet of it. **After changing a route,** walk the critical path. **For each new area,** the view from its entrance.
- **Numbers are measured, not eyeballed:** jumps, drops, doors and stairs against the facts above.

## Common failures

Check your work against these.

- Overstuffed rooms, where every idea is used at once.
- Every room the same size and shape.
- Jumps beyond the player's reach, or drops that should hurt but don't.
- A gate with no hint of how to pass it.
- A dead end with no payoff.
- A room with no way in, or walls with no doors.
- Symmetry everywhere, because it was easy to mirror.
- A landmark hidden by something closer, from the place the player should see it.
- A frame of the critical path with nothing to steer by.
- Detail everywhere: a hundred small blocks where one volume reads the same.

## A worked example

The three-room scenario from this project's first plan: a main room whose front door is blocked by a character, a west wing reached through a high window (it needs a skill), and an east wing reached through a hidden floor tile and an underground storage room. All three connect to an interior garden; its doors to the wings are one-way, so the garden's only entrance is from the main room.

The human wants a cutscene when the player first enters the garden. Where does its trigger go? Every first visit comes through the one door from the main room, so the trigger goes at that threshold, and nowhere else. The reasoning is about the paths, not the geometry: find where every route must pass.

## House rules

Add your own, for example:

- Draw the critical path as a red dashed line.
`;
