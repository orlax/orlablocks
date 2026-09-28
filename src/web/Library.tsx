import { useEffect, useRef, useState } from "react";
import { BookOpen, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import { NAME_PATTERN, SIGIL, type Library, type LibraryEdit, type LibraryKind, type Skill, type Tag, type Uses } from "../shared/library";
import type { ClientMessage, HistorySummary } from "../shared/scene.types";
import { typingInField } from "./keys";
import { RefTextArea, TagsField } from "./RefText";

/**
 * The Library panel (plan 08 §5), docked on the right: the project's skills, tags and design guide, shared by every
 * scene. It has its own undo history, with Undo / Redo in its header and ⌘Z / ⇧⌘Z while focus is in it (outside a
 * text field). Edits are sent as `update_library`, one step each.
 */

type Tab = "skills" | "tags" | "guide";
const TAB_KEY = "dd.library.tab";
/** The guide is saved this long after typing stops (and when the field is left). */
export const GUIDE_SAVE_DELAY_MS = 1000;

const loadTab = (): Tab => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return t === "tags" || t === "guide" ? t : "skills";
  } catch {
    return "skills";
  }
};

export function LibraryPanel({
  library,
  history,
  uses,
  send,
  onClose,
}: {
  library: Library;
  history: HistorySummary;
  uses: Uses;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(loadTab);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Remembering the tab is a convenience.
    }
  }, [tab]);
  const edit = (e: LibraryEdit) => send({ type: "update_library", ...e });

  return (
    <aside
      className="library-panel"
      onKeyDown={(e) => {
        if (typingInField(e.nativeEvent) || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
        e.preventDefault();
        send({ type: e.shiftKey ? "library_redo" : "library_undo" });
      }}
    >
      <header>
        <BookOpen size={14} className="icon" />
        <nav>
          {(["skills", "tags", "guide"] as const).map((t) => (
            <button key={t} type="button" className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t === "skills" ? `Skills ${library.skills.length}` : t === "tags" ? `Tags ${library.tags.length}` : "Guide"}
            </button>
          ))}
        </nav>
        <button type="button" disabled={!history.canUndo} title={history.undoLabel ? `Undo in the library: ${history.undoLabel} (⌘Z)` : "Nothing to undo in the library"} onClick={() => send({ type: "library_undo" })}>
          <Undo2 size={14} />
        </button>
        <button type="button" disabled={!history.canRedo} title={history.redoLabel ? `Redo in the library: ${history.redoLabel} (⇧⌘Z)` : "Nothing to redo in the library"} onClick={() => send({ type: "library_redo" })}>
          <Redo2 size={14} />
        </button>
        <button type="button" title="Close the library" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="library-body">
        {tab === "guide" ? (
          <GuideEditor library={library} onSave={(guide) => edit({ guide })} />
        ) : (
          <RecordList key={tab} kind={tab === "skills" ? "skill" : "tag"} library={library} uses={uses} edit={edit} />
        )}
      </div>
    </aside>
  );
}

function usedText(u: { nodes: number; scenes: number } | undefined) {
  if (!u) return "unused";
  return `${u.nodes} node${u.nodes === 1 ? "" : "s"}${u.scenes > 1 ? ` in ${u.scenes} scenes` : ""}`;
}

function RecordList({ kind, library, uses, edit }: { kind: LibraryKind; library: Library; uses: Uses; edit: (e: LibraryEdit) => void }) {
  const records: (Tag | Skill)[] = kind === "tag" ? library.tags : library.skills;
  const [openName, setOpenName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const noun = kind === "tag" ? "tag" : "skill";

  return (
    <>
      <p className="library-intro">
        {kind === "skill"
          ? "What the player can do. Write @name in any description to refer to one; the agent designs around them."
          : "Properties of things, carried by nodes. Write #name in any description to refer to one."}
      </p>
      {adding ? (
        <NewRecord kind={kind} library={library} onDone={() => setAdding(false)} edit={edit} onAdded={setOpenName} />
      ) : (
        <button type="button" className="labeled add" onClick={() => setAdding(true)}>
          <Plus size={14} /> New {noun}
        </button>
      )}
      <ul className="records">
        {records.map((r) => (
          <li key={r.name} className={openName === r.name ? "record open" : "record"}>
            <button type="button" className="record-head" onClick={() => setOpenName(openName === r.name ? null : r.name)}>
              <span className={`sigil ${kind}`}>{SIGIL[kind]}</span>
              <span className="name">{r.name}</span>
              <span className="used">{usedText((kind === "tag" ? uses.tags : uses.skills)[r.name])}</span>
              {openName !== r.name && r.description && <span className="line">{r.description.split("\n")[0]}</span>}
            </button>
            {openName === r.name && <RecordEditor kind={kind} record={r} library={library} edit={edit} onRenamed={setOpenName} />}
          </li>
        ))}
        {records.length === 0 && !adding && <li className="empty">No {noun}s yet.</li>}
      </ul>
    </>
  );
}

/** A text area that sends on leaving it (or ⌘Enter); Esc puts the saved text back. */
function DescriptionEditor({ library, value, onSave, placeholder }: { library: Library; value: string; onSave: (text: string) => void; placeholder: string }) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <RefTextArea
      library={library}
      className="description"
      rows={3}
      placeholder={placeholder}
      value={text ?? value}
      onFocus={() => setText(value)}
      onValue={setText}
      onBlur={() => {
        if (!cancelled.current && text !== null && text.trim() !== value) onSave(text.trim());
        cancelled.current = false;
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancelled.current = true;
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) e.currentTarget.blur();
      }}
    />
  );
}

function RecordEditor({
  kind,
  record,
  library,
  edit,
  onRenamed,
}: {
  kind: LibraryKind;
  record: Tag | Skill;
  library: Library;
  edit: (e: LibraryEdit) => void;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(record.name);
  useEffect(() => setName(record.name), [record.name]);
  const valid = NAME_PATTERN.test(name);
  const rename = () => {
    if (name === record.name) return;
    if (!valid) return setName(record.name);
    edit({ rename: [{ kind, from: record.name, to: name }] });
    onRenamed(name);
  };
  return (
    <div className="record-editor">
      <label>
        <span>name</span>
        <input
          className={valid ? undefined : "invalid"}
          value={name}
          title="Lowercase letters, digits, _ and -, starting with a letter. Renaming keeps the old name as an alias, so what refers to it still works"
          onChange={(e) => setName(e.target.value.toLowerCase())}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(record.name);
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      <DescriptionEditor
        library={library}
        value={record.description ?? ""}
        placeholder={kind === "skill" ? "What the player can do with it: moves objects tagged #light…" : "What it means: small enough to lift…"}
        onSave={(description) => (kind === "skill" && !description ? undefined : edit({ upsert: [{ kind, name: record.name, description }] }))}
      />
      {kind === "skill" && (
        <label className="stacked">
          <span>acts on</span>
          <TagsField
            library={library}
            tags={(record as Skill).tags ?? []}
            onChange={(tags) => edit({ upsert: [{ kind: "skill", name: record.name, tags }] })}
            onCreate={(tag) => edit({ upsert: [{ kind: "tag", name: tag }, { kind: "skill", name: record.name, tags: [...((record as Skill).tags ?? []), tag] }] })}
          />
        </label>
      )}
      <div className="record-actions">
        {record.aliases && record.aliases.length > 0 && (
          <span className="aliases" title="Old names: references to them still work">
            also {record.aliases.map((a) => `${SIGIL[kind]}${a}`).join(", ")}
          </span>
        )}
        <button type="button" className="labeled danger" title={`Delete ${SIGIL[kind]}${record.name}: what refers to it stays, unresolved (undo brings it back)`} onClick={() => edit({ remove: [{ kind, name: record.name }] })}>
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </div>
  );
}

function NewRecord({
  kind,
  library,
  edit,
  onDone,
  onAdded,
}: {
  kind: LibraryKind;
  library: Library;
  edit: (e: LibraryEdit) => void;
  onDone: () => void;
  onAdded: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const taken = (kind === "tag" ? library.tags : library.skills).some((r) => r.name === name || r.aliases?.includes(name));
  const problem =
    name === "" ? null : !NAME_PATTERN.test(name) ? "lowercase letters, digits, _ and -, starting with a letter" : taken ? `${SIGIL[kind]}${name} already exists` : null;
  const ready = name !== "" && !problem && (kind === "tag" || description.trim() !== "");
  const add = () => {
    if (!ready) return;
    edit({ upsert: [{ kind, name, description: description.trim(), ...(kind === "skill" ? { tags } : {}) }] });
    onAdded(name);
    onDone();
  };
  return (
    <div className="record-editor new">
      <label>
        <span>{SIGIL[kind]}</span>
        <input
          autoFocus
          value={name}
          placeholder={kind === "skill" ? "telekinesis" : "climbable"}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/^[#@]/, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            if (e.key === "Escape") onDone();
          }}
        />
      </label>
      {problem && <div className="ref-unknown">{problem}</div>}
      <RefTextArea
        library={library}
        className="description"
        rows={3}
        placeholder={kind === "skill" ? "What the player can do with it (needed)" : "What it means (optional)"}
        value={description}
        onValue={setDescription}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
          if (e.key === "Escape") onDone();
        }}
      />
      {kind === "skill" && (
        <label className="stacked">
          <span>acts on</span>
          <TagsField library={library} tags={tags} onChange={setTags} />
        </label>
      )}
      <div className="record-actions">
        <button type="button" className="labeled" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="labeled primary" disabled={!ready} onClick={add}>
          Add {kind}
        </button>
      </div>
    </div>
  );
}

/** The design guide: a text area saved a moment after typing stops, and when it's left. */
function GuideEditor({ library, onSave }: { library: Library; onSave: (text: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current !== null && pending.current !== library.guide) onSave(pending.current);
    pending.current = null;
  };
  // Save what's typed when the panel closes or the tab changes.
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="guide-editor">
      <p className="library-intro">
        What a good level is for this game: goals, the game's facts, principles, failures to avoid, house rules. Markdown. The agent reads it before
        designing (get_guide design).
      </p>
      <RefTextArea
        library={library}
        className="guide"
        spellCheck
        value={text ?? library.guide}
        onFocus={() => setText(library.guide)}
        onValue={(t) => {
          setText(t);
          pending.current = t;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, GUIDE_SAVE_DELAY_MS);
        }}
        onBlur={() => {
          flush();
          setText(null);
        }}
      />
    </div>
  );
}
