/**
 * The code editor, loaded only when a code editor is actually shown.
 *
 * CodeMirror and its language modes are by far the largest thing this app
 * depends on. Importing it statically put all of it in the first chunk, so
 * every user paid the download and parse cost before the upload dialog even
 * appeared — including the many who only ever look at the Quality inbox.
 *
 * Now that every code block lives inside a section that starts closed, the
 * editor is genuinely not needed until someone opens one. `lazy` turns that
 * into a separate chunk fetched at that moment.
 *
 * The placeholder is sized from `minHeight` so opening a section does not make
 * the page jump when the real editor arrives a moment later.
 */
import { lazy, Suspense } from "react";

import type { CodeLanguage } from "./CodeMirrorEditor.tsx";

/*
 * Types only. A value re-export here would be a static import of the heavy
 * module, which puts it straight back into the first chunk and undoes the
 * whole point.
 */
export type { CodeLanguage };

const Editor = lazy(() =>
  import("./CodeMirrorEditor.tsx").then((module) => ({ default: module.CodeEditor }))
);

export interface CodeEditorProps {
  value: string;
  language: CodeLanguage;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  label?: string;
  minHeight?: number;
}

export function CodeEditor(props: CodeEditorProps) {
  const minHeight = props.minHeight ?? 180;

  return (
    <Suspense
      fallback={
        <div className="codeLoading" style={{ minHeight }} aria-busy="true">
          <span>Loading editor…</span>
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
