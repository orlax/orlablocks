import { Bot, X } from "lucide-react";
import type { AgentInfo } from "../shared/scene.types";

/**
 * Work with agent (plan 14 §8), in the top bar. With no invitation, a button makes the open scene the agent's: it
 * keeps working there while the human opens other scenes of the project (a design race). Invited, a chip names the
 * agent's scene: here (both share it), or elsewhere (a click opens it, to watch or join), with ✕ to stop.
 */
export function AgentChip({
  agent,
  here,
  canInvite,
  onInvite,
  onStop,
  onJoin,
}: {
  agent: AgentInfo | null;
  /** Whether the agent's scene is the one open here. */
  here: boolean;
  /** An entity is open: nothing to invite the agent to. */
  canInvite: boolean;
  onInvite: () => void;
  onStop: () => void;
  onJoin: () => void;
}) {
  if (!agent) {
    if (!canInvite) return null;
    return (
      <button
        type="button"
        className="library-toggle"
        title="Work with agent: this scene becomes the agent's, and it keeps working here while you open other scenes of the project (a design race)"
        onClick={onInvite}
      >
        <Bot size={14} />
      </button>
    );
  }
  return (
    <span className={here ? "agent-chip here" : "agent-chip"}>
      <button
        type="button"
        className="agent-where"
        disabled={here}
        title={here ? "The agent works in this scene with you" : `The agent works in "${agent.name}": open it, to watch or join`}
        onClick={onJoin}
      >
        <Bot size={14} /> {here ? "agent here" : `agent: ${agent.name}`}
      </button>
      <button type="button" className="agent-stop" title="Stop working with the agent: it follows your open scene again" onClick={onStop}>
        <X size={13} />
      </button>
    </span>
  );
}
