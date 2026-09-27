/**
 * Keyboard shortcuts (and our copy / cut / paste) are off while the user types into a text field (renaming in the
 * outliner, and any input added later) or works in a modal (the project picker). Every shortcut listener checks this first. It asks where
 * the key is going instead of keeping a flag, so it can't get out of sync (say, after a blur).
 */
export const typingInField = (e: Event) =>
  e.target instanceof HTMLElement && e.target.matches("input, textarea, select, [contenteditable], .modal *");
