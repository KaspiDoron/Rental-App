"use client";

import { useEffect } from "react";
import { useI18n, LANGS } from "@/lib/i18n";

// Whole-app AI translation at the DOM level. The t() system only covers strings
// that were wrapped in t("..."); this translator walks the RENDERED DOM and
// translates every visible text node, so EVERY page, tag, button and label is
// shown in the chosen language - even hardcoded strings that were never wrapped.
//
// Safety: brand words, numbers/symbols, code/inputs and anything marked
// data-no-translate are left untouched; originals are remembered so switching
// back to English restores instantly.

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "INPUT", "TEXTAREA", "SELECT",
]);
const BRAND = /^(WheelDeal|Ultra|Pro|WhatsApp|Google|AI|OK|QR|km|cc|USD|EUR|ILS|THB)$/i;

// Remember each text node's English original so we can restore it.
const originals = new WeakMap<Text, string>();

function translatable(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest("[data-no-translate]")) return false;
  let el: HTMLElement | null = parent;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.isContentEditable) return false;
    el = el.parentElement;
  }
  const raw = (originals.get(node) ?? node.nodeValue ?? "").trim();
  if (raw.length < 2) return false;
  if (!/[a-zA-Z]/.test(raw)) return false; // numbers/emoji/symbols only
  if (BRAND.test(raw)) return false;
  return true;
}

function cacheGet(lang: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(`wd_i18n_${lang}`) ?? "{}");
  } catch {
    return {};
  }
}
function cacheSet(lang: string, dict: Record<string, string>) {
  try {
    localStorage.setItem(`wd_i18n_${lang}`, JSON.stringify(dict));
  } catch {}
}

export function DomTranslator() {
  const { lang } = useI18n();

  useEffect(() => {
    if (typeof document === "undefined") return;

    // Restore English: put every remembered original back.
    if (lang === "en") {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const t = n as Text;
        const orig = originals.get(t);
        if (orig !== undefined && t.nodeValue !== orig) t.nodeValue = orig;
      }
      return;
    }

    let cancelled = false;
    let dict = cacheGet(lang);
    const langName = LANGS.find((l) => l.code === lang)?.name ?? lang;

    const apply = (node: Text) => {
      const orig = originals.get(node) ?? node.nodeValue ?? "";
      if (!originals.has(node)) originals.set(node, orig);
      const key = orig.trim();
      const hit = dict[key];
      if (hit) {
        // Preserve surrounding whitespace of the original node.
        node.nodeValue = (node.nodeValue ?? "").replace(key, hit);
      }
    };

    const collectAndTranslate = async (root: Node) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const t = n as Text;
        if (translatable(t)) nodes.push(t);
      }
      // Apply what we already have, and gather what we still need.
      const missing = new Set<string>();
      for (const node of nodes) {
        const key = (originals.get(node) ?? node.nodeValue ?? "").trim();
        if (dict[key]) apply(node);
        else missing.add(key);
      }
      const need = [...missing].slice(0, 400);
      if (!need.length) return;

      const BATCH = 42;
      for (let i = 0; i < need.length; i += BATCH) {
        if (cancelled) return;
        try {
          const res = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lang, langName, texts: need.slice(i, i + BATCH) }),
          });
          const data = await res.json();
          if (data.map && !cancelled) {
            dict = { ...dict, ...data.map };
            cacheSet(lang, dict);
            for (const node of nodes) apply(node);
          }
        } catch {
          /* network hiccup - try the rest */
        }
      }
    };

    collectAndTranslate(document.body);

    // Re-translate content that mounts later (modals, results, tabs).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const obs = new MutationObserver((muts) => {
      const added = muts.some((m) => m.addedNodes.length > 0 || m.type === "characterData");
      if (!added) return;
      clearTimeout(timer);
      timer = setTimeout(() => !cancelled && collectAndTranslate(document.body), 400);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      obs.disconnect();
    };
  }, [lang]);

  return null;
}
