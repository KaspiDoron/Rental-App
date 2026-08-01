"use client";

import type { WillMsg } from "@/lib/useWill";

export function WillMessage({ msg }: { msg: WillMsg }) {
  const isWill = msg.role === "will";
  return (
    <div className={`flex ${isWill ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] font-semibold leading-snug pop-in ${
          isWill ? "rounded-bl-md bg-card2 text-strong" : "rounded-br-md bg-brandblue text-white"
        }`}
      >
        {msg.text}
        {msg.receipt && (
          <div className="mt-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-brandblue-soft px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-brandblue">
              ✓ {msg.receipt}
            </span>
          </div>
        )}
        {/* The owner has Will's hands-on half switched off. The message itself
            already names the control to use; this says WHY he is pointing
            rather than doing, so it reads as a temporary state and not as a
            refusal or - worse - a silent failure. */}
        {msg.underDevelopment && (
          <div className="mt-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-warn">
              🚧 Under development
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
