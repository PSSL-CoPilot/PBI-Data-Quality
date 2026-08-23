/**
 * Code editor for DAX, Power Query (M) and SQL.
 *
 * CodeMirror 6 rather than Monaco: it provides the same line numbers, search,
 * selection and highlighting, but ships a fraction of the bytes and needs no
 * web-worker plumbing, which matters for a static site with no build server.
 *
 * DAX and M have no published grammar, so both get a small stream tokenizer
 * here. They classify comments, strings, quoted identifiers, bracketed
 * references, numbers, keywords and function calls — enough for the colouring
 * a reviewer needs, and honest about being a tokenizer rather than a parser.
 */
import { useEffect, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  syntaxHighlighting,
  type StreamParser,
} from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";
import { useTheme } from "./theme.tsx";

export type CodeLanguage = "dax" | "m" | "sql" | "text";

const DAX_KEYWORDS = new Set(
  "VAR RETURN IF SWITCH TRUE FALSE BLANK NOT IN AND OR DEFINE EVALUATE MEASURE COLUMN TABLE ORDER BY ASC DESC START AT".split(
    " "
  )
);

const M_KEYWORDS = new Set(
  "let in if then else each type meta try otherwise error section shared and or not as is optional nullable".split(
    " "
  )
);

/** Shared tokenizer shape for the two languages without a published grammar. */
function makeParser(keywords: Set<string>, lineComments: string[]): StreamParser<unknown> {
  return {
    token(stream) {
      if (stream.eatSpace()) return null;

      for (const marker of lineComments) {
        if (stream.match(marker)) {
          stream.skipToEnd();
          return "comment";
        }
      }
      if (stream.match("/*")) {
        while (!stream.eol()) {
          if (stream.match("*/")) return "comment";
          stream.next();
        }
        return "comment";
      }

      // `#"Quoted Name"` is M's escaped identifier.
      if (stream.match(/^#"(?:[^"]|"")*"/)) return "variableName";

      if (stream.match(/^"(?:[^"]|"")*"/)) return "string";
      // Single quotes wrap a table name in DAX, not a string.
      if (stream.match(/^'(?:[^']|'')*'/)) return "typeName";
      // `[Column]` or `[Measure]`.
      if (stream.match(/^\[[^\]\r\n]*\]/)) return "propertyName";

      if (stream.match(/^-?\d+(?:\.\d+)?/)) return "number";

      const identifier = stream.match(/^[A-Za-z_][\w.]*/) as RegExpMatchArray | null;
      if (identifier) {
        const word = identifier[0];
        if (keywords.has(word) || keywords.has(word.toUpperCase())) return "keyword";
        // A name immediately followed by `(` is being called.
        return /^\s*\(/.test(stream.string.slice(stream.pos)) ? "function" : "variableName";
      }

      if (stream.match(/^[+\-*/&<>=^]+/)) return "operator";

      stream.next();
      return null;
    },
  };
}

const daxLanguage = StreamLanguage.define(makeParser(DAX_KEYWORDS, ["//", "--"]));
const mLanguage = StreamLanguage.define(makeParser(M_KEYWORDS, ["//"]));

/**
 * Two syntax palettes in the spirit of Sublime Text: saturated, high-contrast
 * and distinct per token class, so keywords, functions, strings, numbers and
 * column references are told apart at a glance rather than by shade.
 *
 * Dark follows Monokai; light is its counterpart tuned for contrast on white.
 */
const LIGHT_SYNTAX = HighlightStyle.define([
  { tag: tags.comment, color: "#8a94a6", fontStyle: "italic" },
  { tag: tags.string, color: "#c2410c" },
  { tag: tags.number, color: "#7048e8" },
  { tag: tags.bool, color: "#7048e8" },
  { tag: tags.keyword, color: "#d6336c", fontWeight: "700" },
  { tag: tags.operator, color: "#0b7285" },
  { tag: tags.function(tags.variableName), color: "#1971c2", fontWeight: "600" },
  { tag: tags.propertyName, color: "#0b7285" },
  { tag: tags.typeName, color: "#2f9e44", fontWeight: "600" },
  { tag: tags.variableName, color: "#1f2430" },
  { tag: tags.punctuation, color: "#68707f" },
  { tag: tags.bracket, color: "#68707f" },
]);

const DARK_SYNTAX = HighlightStyle.define([
  { tag: tags.comment, color: "#767d93", fontStyle: "italic" },
  { tag: tags.string, color: "#ffd866" },
  { tag: tags.number, color: "#ab9df2" },
  { tag: tags.bool, color: "#ab9df2" },
  { tag: tags.keyword, color: "#ff6188", fontWeight: "700" },
  { tag: tags.operator, color: "#ff6188" },
  { tag: tags.function(tags.variableName), color: "#78dce8", fontWeight: "600" },
  { tag: tags.propertyName, color: "#a9dc76" },
  { tag: tags.typeName, color: "#fc9867", fontWeight: "600" },
  { tag: tags.variableName, color: "#e8ebf4" },
  { tag: tags.punctuation, color: "#9aa2b6" },
  { tag: tags.bracket, color: "#9aa2b6" },
]);

/** Chrome colours come from the design tokens so the editor matches the app. */
const editorChrome = (dark: boolean) =>
  EditorView.theme(
    {
      "&": { fontSize: "12px", backgroundColor: "var(--surface)", color: "var(--text)" },
      ".cm-content": {
        fontFamily: "var(--mono-font)",
        padding: "12px 0",
        lineHeight: "1.7",
        caretColor: "var(--accent)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--surface-2)",
        color: "var(--text-3)",
        border: "none",
        borderRight: "1px solid var(--border)",
        fontFamily: "var(--mono-font)",
      },
      ".cm-activeLine": { backgroundColor: "var(--surface-3)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--surface-3)", color: "var(--text-2)" },
      "&.cm-focused": { outline: "none" },
      ".cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft)" },
      "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
      ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
      ".cm-panels": {
        backgroundColor: "var(--surface-2)",
        color: "var(--text)",
        borderColor: "var(--border)",
      },
      ".cm-panel input, .cm-panel button": {
        backgroundColor: "var(--surface)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        padding: "3px 6px",
      },
      ".cm-searchMatch": { backgroundColor: "var(--warn-soft)", outline: "1px solid var(--warn)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--warn)", color: "#fff" },
      ".cm-matchingBracket": {
        backgroundColor: "var(--accent-soft)",
        outline: "1px solid var(--accent)",
      },
    },
    { dark }
  );

const themeExtensions = (dark: boolean) => [
  editorChrome(dark),
  syntaxHighlighting(dark ? DARK_SYNTAX : LIGHT_SYNTAX),
];

function languageExtension(language: CodeLanguage) {
  if (language === "sql") return sql();
  if (language === "dax") return daxLanguage;
  if (language === "m") return mLanguage;
  return [];
}

export const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  dax: "DAX",
  m: "Power Query (M)",
  sql: "SQL",
  text: "Source definition",
};

export function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
  label,
  minHeight = 180,
}: {
  value: string;
  language: CodeLanguage;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  label?: string;
  minHeight?: number;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Held in a ref so the editor is not torn down and rebuilt whenever the
  // parent re-renders with a new closure.
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);

  const { resolved } = useTheme();
  const [wrap, setWrap] = useState(true);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapping = useRef(new Compartment());
  const themeSlot = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          languageExtension(language),
          themeSlot.current.of(themeExtensions(resolved === "dark")),
          wrapping.current.of(EditorView.lineWrapping),
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });

    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor owns its document after mount; `value` changes from outside are
    // handled by the effect below so typing is never interrupted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  // Adopt an external value change (a revert, or switching object) without
  // clobbering the cursor while the user is typing.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  // Swap palettes in place rather than rebuilding, so the document, cursor and
  // scroll position all survive a theme change.
  useEffect(() => {
    view.current?.dispatch({
      effects: themeSlot.current.reconfigure(themeExtensions(resolved === "dark")),
    });
  }, [resolved]);

  // Escape leaves full screen, which is the shortcut people try first.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [full]);

  const copy = async () => {
    const text = view.current?.state.doc.toString() ?? value;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={full ? "codeShell full" : "codeShell"}>
      <div className="codeBar">
        <b>{label ?? LANGUAGE_LABEL[language]}</b>
        {readOnly && <span className="badge flat">read only</span>}
        <span className="codeHint">Ctrl+F to search</span>
        <button type="button" onClick={() => setWrap((w) => !w)} title="Toggle word wrap">
          {wrap ? "⇥ Wrap on" : "⇥ Wrap off"}
        </button>
        <button type="button" onClick={copy} title="Copy to clipboard">
          {copied ? "✓ Copied" : "⧉ Copy"}
        </button>
        <button
          type="button"
          onClick={() => setFull((f) => !f)}
          title={full ? "Exit full screen (Esc)" : "Full screen"}
        >
          {full ? "⤡ Exit full screen" : "⤢ Full screen"}
        </button>
      </div>
      <div className="codeBody" style={{ minHeight: full ? undefined : minHeight }} ref={host} />
    </div>
  );
}
