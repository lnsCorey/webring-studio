import React, { useRef, useState } from 'react';
import { renderMarkdown } from '../shared/markdown';

/**
 * A Markdown textarea with a formatting toolbar and a Raw / Preview switch.
 * The preview uses the same safe renderer as the published page (it escapes everything first),
 * so what you see is what gets published.
 */
export function MarkdownField(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  className?: string;
}) {
  const [preview, setPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const tab = (active: boolean) =>
    `px-2 py-0.5 rounded-md text-[11px] font-semibold transition ${
      active ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
    }`;

  const toolBtn =
    'px-1.5 py-0.5 rounded text-[11px] font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';

  const applyEdit = (before: string, after: string, fallback: string, block = false) => {
    const el = textareaRef.current;
    const src = props.value || '';
    const start = el ? el.selectionStart : src.length;
    const end = el ? el.selectionEnd : src.length;
    const selected = src.slice(start, end) || fallback;
    const prefix = block && start > 0 && src[start - 1] !== '\n' ? '\n' : '';
    const suffix = block && end < src.length && src[end] !== '\n' ? '\n' : '';
    const inserted = `${prefix}${before}${selected}${after}${suffix}`;
    const next = (src.slice(0, start) + inserted + src.slice(end)).slice(0, 10000);
    props.onChange(next);
    if (el) {
      const selStart = start + prefix.length + before.length;
      const selEnd = selStart + selected.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(selStart, selEnd);
      });
    }
  };

  return (
    <div className={props.className}>
      <div className="flex flex-wrap items-center gap-1 mb-1.5 rounded-lg bg-slate-900/70 border border-slate-800 px-1.5 py-1">
        <div className="inline-flex items-center gap-0.5 mr-1" role="tablist" aria-label="Markdown view mode">
          <button
            type="button"
            role="tab"
            aria-selected={!preview}
            className={tab(!preview)}
            onClick={() => setPreview(false)}
          >
            Raw
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={preview}
            className={tab(preview)}
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
        </div>

        {!preview && (
          <div className="flex flex-wrap items-center gap-0.5 border-l border-slate-800 pl-1.5" role="toolbar" aria-label="Markdown formatting">
            <button type="button" className={toolBtn} title="Bold (**text**)" onClick={() => applyEdit('**', '**', 'bold text')}>
              B
            </button>
            <button type="button" className={`${toolBtn} italic`} title="Italic (*text*)" onClick={() => applyEdit('*', '*', 'italic text')}>
              I
            </button>
            <button type="button" className={toolBtn} title="Heading (## Heading)" onClick={() => applyEdit('## ', '', 'Heading', true)}>
              H2
            </button>
            <button type="button" className={toolBtn} title="Quote (> quote)" onClick={() => applyEdit('> ', '', 'Quote', true)}>
              &ldquo;
            </button>
            <button type="button" className={toolBtn} title="Bullet list (- item)" onClick={() => applyEdit('- ', '', 'List item', true)}>
              • List
            </button>
            <button type="button" className={toolBtn} title="Link ([label](https://…))" onClick={() => applyEdit('[', '](https://example.com)', 'link text')}>
              Link
            </button>
            <button type="button" className={`${toolBtn} font-mono`} title="Inline code (`code`)" onClick={() => applyEdit('`', '`', 'code')}>
              `code`
            </button>
            <button
              type="button"
              className={`${toolBtn} font-mono`}
              title="Fenced code block (```lang)"
              onClick={() => applyEdit('```ts\n', '\n```', '// code example', true)}
            >
              {'</>'} Block
            </button>
          </div>
        )}
      </div>

      {preview ? (
        <div
          className="studio-prose min-h-[5rem] px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(props.value) || '<p class="text-slate-500">Nothing to preview.</p>',
          }}
        />
      ) : (
        <textarea
          ref={textareaRef}
          required={props.required}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value.slice(0, 10000))}
          placeholder={props.placeholder}
          rows={props.rows ?? 6}
          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono leading-relaxed focus:border-indigo-500 focus:outline-none"
        />
      )}
    </div>
  );
}
