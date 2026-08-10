"use client";

import { useCallback, useEffect, useState } from "react";
// The language list is imported from the app's own catalogue rather than served
// by the route, so the picker can never drift from the languages the app
// actually offers - and the route stays free of the client i18n module.
import { LANGS } from "@/lib/i18n";

// TRANSLATION REPAIR - Wave C / M23.
//
// A machine translation that reads wrong in the target language used to need a
// deploy to fix. The owner's only other options were to change the English
// source, which changes it for everyone, or to live with it.
//
// Two rules govern this screen:
//
// 1. A CORRECTION IS SHOWN NEXT TO WHAT IT REPLACES. An override on its own is
//    unjudgeable - the owner cannot tell whether it is still needed after a
//    re-translation. So the machine's current output travels with it.
// 2. CLEARING IS THE SAME VERB AS SETTING. An empty field reverts to the
//    machine translation. A separate delete button invites a wrong-row tap on
//    a phone; an empty field does not.
//
// Mobile first: single column at 320px, textareas at 16px so iOS does not zoom.

interface Payload {
  lang: string;
  overrides: Record<string, string>;
  machineFor: Record<string, string>;
  machineCount: number;
  limit: number;
}

const TRANSLATABLE = LANGS.filter((l) => l.code !== "en");

export default function TranslationRepairPanel() {
  const [lang, setLang] = useState(TRANSLATABLE[0]?.code ?? "es");
  const [data, setData] = useState<Payload | null>(null);
  // null means "could not be read", which is not the same as "no corrections".
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (code: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/admin/i18n?lang=${encodeURIComponent(code)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) {
        setData(null);
        setError(j?.error ?? "Could not read the corrections.");
        return;
      }
      setData(j as Payload);
    } catch {
      setData(null);
      setError("Could not read the corrections.");
    }
  }, []);

  useEffect(() => {
    void load(lang);
  }, [lang, load]);

  async function save(src: string, value: string) {
    if (!src.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch("/api/admin/i18n", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang, source: src, text: value }),
      });
      const j = await r.json();
      if (!r.ok) {
        setNote(j?.error ?? "Could not save.");
      } else {
        setNote(value.trim() ? "Saved." : "Reverted to the machine translation.");
        setSource("");
        setText("");
        await load(lang);
      }
    } catch {
      setNote("Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const entries = Object.entries(data?.overrides ?? {});

  return (
    <div className="space-y-3">
      <div className="surface-strong rounded-2xl p-3">
        <div className="text-sm font-extrabold">Translation repair</div>
        <p className="text-soft mt-1 text-xs leading-relaxed">
          Correct a machine translation without a deploy. Corrections are stored
          separately from the machine cache, so a later re-translation cannot
          overwrite them. English is the source language - to change an English
          string, change it in the code.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-soft text-xs font-bold" htmlFor="i18n-lang">
            Language
          </label>
          <select
            id="i18n-lang"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="border-line bg-card text-strong focus:border-brandblue rounded-xl border-2 px-3 py-2 text-base font-bold focus:outline-none"
          >
            {TRANSLATABLE.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.name}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <p className="mt-3 text-xs font-bold text-amber-400">{error}</p>
        ) : data ? (
          <p className="text-faint mt-3 text-xs">
            {entries.length} of {data.limit} corrections &middot;{" "}
            {data.machineCount.toLocaleString()} strings in the machine cache
          </p>
        ) : (
          <p className="text-faint mt-3 text-xs">Reading&hellip;</p>
        )}
      </div>

      {/* ADD OR EDIT. The English source is the key, so pasting the exact
          catalogue string is the whole lookup - no id to find, no list to
          scroll on a phone. */}
      <div className="surface-strong space-y-2 rounded-2xl p-3">
        <div className="text-xs font-extrabold">Correct a string</div>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          rows={2}
          placeholder="The English source string, exactly as it appears in the app"
          className="border-line bg-card text-strong focus:border-brandblue w-full rounded-xl border-2 px-3 py-2 text-base focus:outline-none"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="The correct translation (leave empty to revert to the machine translation)"
          className="border-line bg-card text-strong focus:border-brandblue w-full rounded-xl border-2 px-3 py-2 text-base focus:outline-none"
        />
        <button
          onClick={() => void save(source, text)}
          disabled={busy || !source.trim()}
          className="btn btn-sm bg-brandblue rounded-xl px-3 py-2 text-xs font-extrabold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save correction"}
        </button>
        {note && <p className="text-soft text-xs font-bold">{note}</p>}
      </div>

      {/* THE LEDGER. Machine output beside every correction - see rule 1. */}
      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map(([src, corrected]) => (
            <div key={src} className="surface-strong rounded-2xl p-3">
              <div className="text-xs font-extrabold break-words">{src}</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <div className="text-faint text-[10px] font-bold uppercase">
                    Machine
                  </div>
                  <div className="text-soft mt-0.5 text-xs break-words">
                    {data?.machineFor[src] ? (
                      data.machineFor[src]
                    ) : (
                      <span className="text-faint">
                        not translated - the correction is the only version
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-emerald-400">
                    Yours
                  </div>
                  <div className="mt-0.5 text-xs break-words">{corrected}</div>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => {
                    setSource(src);
                    setText(corrected);
                  }}
                  className="btn btn-sm rounded-xl px-3 py-1.5 text-[11px] font-extrabold"
                >
                  Edit
                </button>
                <button
                  onClick={() => void save(src, "")}
                  disabled={busy}
                  className="btn btn-sm rounded-xl px-3 py-1.5 text-[11px] font-extrabold disabled:opacity-50"
                >
                  Revert
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && entries.length === 0 && !error && (
        <p className="text-faint px-1 text-xs">
          No corrections for this language. The machine translation is being used
          everywhere.
        </p>
      )}
    </div>
  );
}
