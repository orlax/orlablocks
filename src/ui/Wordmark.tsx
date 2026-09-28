import type { CSSProperties } from "react";

/** The line under a large wordmark, in the Control Panel and on the editor's welcome. */
export const TAGLINE = "Block out your levels. Let your agents build with you.";

/** The six letter blocks, each a pastel with its dark shade and when it rises in. */
const BLOCKS = [
  { letter: "B", color: "mint", delay: 0.05 },
  { letter: "L", color: "peach", delay: 0.12 },
  { letter: "O", color: "coral", delay: 0.19 },
  { letter: "C", color: "lilac", delay: 0.26 },
  { letter: "K", color: "sky", delay: 0.33 },
  { letter: "S", color: "leaf", delay: 0.4 },
];

/**
 * The wordmark, **orla BLOCKS** (plan 12 §4): "Orla", then six letter blocks. A large one rises in by default (not
 * with reduced motion); a small one is still. Screen readers hear "OrlaBlocks".
 */
export function Wordmark({ size = "large", animated = size === "large", className }: {
  size?: "small" | "large";
  animated?: boolean;
  className?: string;
}) {
  const classes = ["wordmark", size, animated ? "animated" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <h1 className={classes} aria-label="OrlaBlocks">
      <span className="orla" aria-hidden="true">
        Orla
      </span>
      <span className="blocks" aria-hidden="true">
        {BLOCKS.map((b) => (
          <span
            key={b.letter}
            className="blk"
            style={{ "--c": `var(--${b.color})`, "--cd": `var(--${b.color}-d)`, "--d": `${b.delay}s` } as CSSProperties}
          >
            {b.letter}
          </span>
        ))}
      </span>
    </h1>
  );
}
