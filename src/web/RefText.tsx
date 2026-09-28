import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { X } from "lucide-react";
import { findRefs, MAX_NAME, NAME_PATTERN, resolveRef, SIGIL, type Library, type LibraryKind } from "../shared/library";

/**
 * Text that refers to the project library (plan 08 §5): a text area that highlights `@skills` and `#tags` (known
 * ones tinted, unknown ones underlined and listed below) and completes them as they're typed, and a field of tag
 * chips. The highlight is a backdrop under a transparent text area with the same metrics, so typing stays native.
 */

/** The reference being typed at the caret: its sigil's index and what follows it so far. */
function refAtCaret(text: string, caret: number): { kind: LibraryKind; start: number; query: string } | null {
  const m = /(^|[^\p{L}\p{N}_@#-])([@#])([a-zA-Z0-9_-]*)$/u.exec(text.slice(0, caret));
  if (!m) return null;
  return { kind: m[2] === "@" ? "skill" : "tag", start: m.index + m[1].length, query: m[3].toLowerCase() };
}

/** Library names of `kind` starting with (then containing) `query`, best first. */
function suggestions(library: Library, kind: LibraryKind, query: string, exclude: string[] = [], limit = 8): string[] {
  const names = (kind === "tag" ? library.tags : library.skills).map((r) => r.name).filter((n) => !exclude.includes(n));
  const starts = names.filter((n) => n.startsWith(query));
  const contains = names.filter((n) => !n.startsWith(query) && n.includes(query));
  return [...starts, ...contains].slice(0, limit);
}

type Suggest = { kind: LibraryKind; start: number; end: number; items: string[]; index: number };

export function RefTextArea({
  library,
  value,
  onValue,
  onKeyDown,
  className,
  ...rest
}: { library: Library | null; value: string; onValue: (text: string) => void } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const area = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const caretAfter = useRef<number | null>(null);

  // Put the caret after a completion once React has set the new text.
  useLayoutEffect(() => {
    if (caretAfter.current === null || !area.current) return;
    area.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  });

  const refs = useMemo(() => findRefs(value), [value]);
  const unknown = library ? [...new Set(refs.filter((r) => !resolveRef(library, r.kind, r.name)).map((r) => `${SIGIL[r.kind]}${r.name}`))] : [];

  const update = (text: string, caret: number) => {
    if (!library) return setSuggest(null);
    const at = refAtCaret(text, caret);
    const items = at ? suggestions(library, at.kind, at.query) : [];
    setSuggest(at && items.length > 0 && !(items.length === 1 && items[0] === at.query) ? { kind: at.kind, start: at.start, end: caret, items, index: 0 } : null);
  };

  const pick = (name: string) => {
    if (!suggest) return;
    const insert = `${SIGIL[suggest.kind]}${name}`;
    const after = value.slice(suggest.end);
    const text = value.slice(0, suggest.start) + insert + (after.startsWith(" ") ? "" : " ") + after;
    caretAfter.current = suggest.start + insert.length + 1;
    setSuggest(null);
    onValue(text);
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggest.items.length;
        return setSuggest({ ...suggest, index: (suggest.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        return pick(suggest.items[suggest.index]);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setSuggest(null);
      }
    }
    onKeyDown?.(e);
  };

  // The backdrop: the same text, transparent, with each reference in a span that tints or underlines it.
  const pieces: { text: string; cls?: string }[] = [];
  let i = 0;
  for (const r of refs) {
    if (r.start > i) pieces.push({ text: value.slice(i, r.start) });
    const known = !library || !!resolveRef(library, r.kind, r.name);
    pieces.push({ text: value.slice(r.start, r.end), cls: known ? `ref ${r.kind}` : "ref unknown" });
    i = r.end;
  }
  pieces.push({ text: value.slice(i) + "\n" });

  return (
    <div className={`ref-text ${className ?? ""}`}>
      <div className="ref-field">
        <div className="ref-backdrop" ref={backdrop} aria-hidden>
          {pieces.map((p, k) => (p.cls ? <mark key={k} className={p.cls}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
        </div>
        <textarea
          {...rest}
          ref={area}
          value={value}
          spellCheck={rest.spellCheck ?? true}
          onChange={(e) => {
            onValue(e.target.value);
            update(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => update(e.currentTarget.value, e.currentTarget.selectionStart)}
          onScroll={(e) => {
            if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={keyDown}
          onBlur={(e) => {
            setSuggest(null);
            rest.onBlur?.(e);
          }}
        />
      </div>
      {suggest && (
        <ul className="ref-suggest" role="listbox">
          {suggest.items.map((name, k) => (
            <li
              key={name}
              role="option"
              aria-selected={k === suggest.index}
              className={k === suggest.index ? "active" : undefined}
              // Before the blur, so the pick lands.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(name);
              }}
            >
              <span className={`sigil ${suggest.kind}`}>{SIGIL[suggest.kind]}</span>
              {name}
              <span className="hint">{describe(library!, suggest.kind, name)}</span>
            </li>
          ))}
        </ul>
      )}
      {unknown.length > 0 && <div className="ref-unknown">Not in the library: {unknown.join(", ")}</div>}
    </div>
  );
}

const describe = (library: Library, kind: LibraryKind, name: string) => {
  const r = resolveRef(library, kind, name);
  return r?.description?.split("\n")[0] ?? "";
};

/**
 * Tag chips with a field that adds one: it completes from the library, and offers "Create #name" for a new name
 * (`onCreate`, which adds it to the library and then here). Backspace in the empty field drops the last chip.
 */
export function TagsField({
  library,
  tags,
  onChange,
  onCreate,
  placeholder = "add a tag…",
}: {
  library: Library | null;
  tags: string[];
  onChange: (tags: string[]) => void;
  onCreate?: (name: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const query = text.trim().replace(/^#/, "").toLowerCase();
  const items = library && focused ? suggestions(library, "tag", query, tags) : [];
  const exists = library ? !!resolveRef(library, "tag", query) : false;
  const creatable = !!onCreate && query !== "" && !exists && NAME_PATTERN.test(query) && query.length <= MAX_NAME;
  const options = [...items.map((name) => ({ name, create: false })), ...(creatable ? [{ name: query, create: true }] : [])];

  const choose = (o: { name: string; create: boolean }) => {
    if (o.create) onCreate!(o.name);
    else if (!tags.includes(o.name)) onChange([...tags, o.name]);
    setText("");
    setIndex(0);
  };

  return (
    <div className="tags-field">
      <div className="chips">
        {tags.map((t) => (
          <span key={t} className="chip" title={library ? describe(library, "tag", t) : undefined}>
            #{t}
            <button type="button" title={`Remove #${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          value={text}
          placeholder={tags.length === 0 ? placeholder : ""}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (options.length > 0) setIndex((index + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
            } else if (e.key === "Enter" || (e.key === "Tab" && options.length > 0 && query !== "")) {
              e.preventDefault();
              const exact = exists && library ? resolveRef(library, "tag", query)!.name : null;
              if (exact) choose({ name: exact, create: false });
              else if (options[index]) choose(options[index]);
            } else if (e.key === "Escape") {
              setText("");
              e.currentTarget.blur();
            } else if (e.key === "Backspace" && text === "" && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
        />
      </div>
      {focused && options.length > 0 && (
        <ul className="ref-suggest" role="listbox">
          {options.map((o, k) => (
            <li
              key={`${o.create}-${o.name}`}
              role="option"
              aria-selected={k === index}
              className={k === index ? "active" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
            >
              {o.create ? (
                <>
                  Create <span className="sigil tag">#</span>
                  {o.name}
                </>
              ) : (
                <>
                  <span className="sigil tag">#</span>
                  {o.name}
                  <span className="hint">{describe(library!, "tag", o.name)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
