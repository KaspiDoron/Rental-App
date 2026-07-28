import { Fragment, type ReactNode } from "react";
import { tokenizeWa, type WaToken } from "@/lib/wa/format";

// Presentation only. The grammar lives in lib/wa/format so the same parse backs
// plain-text previews and can be tested without a React runtime.
//
// Output is React elements, never dangerouslySetInnerHTML, so nothing a shop
// types can become markup.

function render(tokens: WaToken[]): ReactNode[] {
  return tokens.map((tok, i) => {
    if (tok.kind === "text") return <Fragment key={i}>{tok.text}</Fragment>;
    const kids = render(tok.children);
    switch (tok.style) {
      case "bold":
        return (
          <strong key={i} className="font-extrabold">
            {kids}
          </strong>
        );
      case "italic":
        return <em key={i}>{kids}</em>;
      case "strike":
        return (
          <s key={i} className="opacity-70">
            {kids}
          </s>
        );
      case "code":
        return (
          <code key={i} className="rounded bg-black/10 px-1 font-mono text-[0.92em]">
            {kids}
          </code>
        );
    }
  });
}

/** Render a WhatsApp message body with its formatting applied. */
export function WaText({ text, className }: { text: string; className?: string }) {
  return <span className={className}>{render(tokenizeWa(text))}</span>;
}
