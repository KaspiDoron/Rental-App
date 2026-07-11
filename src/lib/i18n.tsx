"use client";

// Global AI translation.
//
// How it works: UI strings are wrapped in t("..."). English is the source of
// truth. When the user picks another language (globe button, available from
// the login screen onwards), the catalogue is translated by our AI providers
// (via /api/translate - real LLM translation, tuned for app UI, cached in
// Supabase + localStorage). Any string t() sees that is not yet translated is
// queued and swept automatically, so coverage is complete even for lazily
// mounted screens. Messages the agents send to VENDORS are not affected -
// those are composed server-side (English, or the shop's local language for
// Ultra members).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface Lang {
  code: string;
  name: string;
  flag: string;
  rtl?: boolean;
}

export const LANGS: Lang[] = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "fr", name: "Français", flag: "🇫🇷" },
  { code: "de", name: "Deutsch", flag: "🇩🇪" },
  { code: "it", name: "Italiano", flag: "🇮🇹" },
  { code: "pt", name: "Português", flag: "🇵🇹" },
  { code: "nl", name: "Nederlands", flag: "🇳🇱" },
  { code: "ru", name: "Русский", flag: "🇷🇺" },
  { code: "uk", name: "Українська", flag: "🇺🇦" },
  { code: "pl", name: "Polski", flag: "🇵🇱" },
  { code: "tr", name: "Türkçe", flag: "🇹🇷" },
  { code: "he", name: "עברית", flag: "🇮🇱", rtl: true },
  { code: "ar", name: "العربية", flag: "🇸🇦", rtl: true },
  { code: "hi", name: "हिन्दी", flag: "🇮🇳" },
  { code: "th", name: "ไทย", flag: "🇹🇭" },
  { code: "id", name: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "vi", name: "Tiếng Việt", flag: "🇻🇳" },
  { code: "zh", name: "中文", flag: "🇨🇳" },
  { code: "ja", name: "日本語", flag: "🇯🇵" },
  { code: "ko", name: "한국어", flag: "🇰🇷" },
];

type Dict = Record<string, string>;

interface I18nValue {
  lang: string;
  setLang: (code: string) => void;
  t: (s: string) => string;
  busy: boolean;
  error: string | null;
}

const I18nContext = createContext<I18nValue>({
  lang: "en",
  setLang: () => {},
  t: (s) => s,
  busy: false,
  error: null,
});

import { I18N_CATALOG } from "./i18n-catalog";

// Strings seen by t() that still need a translation (swept in batches).
const pending = new Set<string>();
// The FULL app catalogue (generated at build time from every t("...") in the
// codebase) plus anything t() sees at runtime. Seeding with the catalogue is
// what makes a language switch translate EVERY page - tags, buttons, admin,
// profile - not only the screens that happen to be mounted right now.
const registry = new Set<string>(I18N_CATALOG);

function cacheGet(lang: string): Dict {
  try {
    return JSON.parse(localStorage.getItem(`wd_i18n_${lang}`) ?? "{}");
  } catch {
    return {};
  }
}

function cacheSet(lang: string, dict: Dict) {
  try {
    localStorage.setItem(`wd_i18n_${lang}`, JSON.stringify(dict));
  } catch {}
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState("en");
  const [dict, setDict] = useState<Dict>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sweepTimer = useRef<ReturnType<typeof setTimeout>>();
  const langRef = useRef(lang);
  langRef.current = lang;

  const applyDirection = useCallback((code: string) => {
    const meta = LANGS.find((l) => l.code === code);
    document.documentElement.setAttribute("lang", code);
    document.documentElement.setAttribute("dir", meta?.rtl ? "rtl" : "ltr");
  }, []);

  const fetchTranslations = useCallback(
    async (code: string, texts: string[]) => {
      if (code === "en" || texts.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        // Batch so each request stays well inside the serverless time budget
        // (the whole-app catalogue can be hundreds of strings). Results apply
        // progressively - the page translates as batches land.
        const BATCH = 42;
        for (let i = 0; i < texts.length; i += BATCH) {
          if (langRef.current !== code) break; // user switched again
          const res = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lang: code,
              langName: LANGS.find((l) => l.code === code)?.name ?? code,
              texts: texts.slice(i, i + BATCH),
            }),
          });
          const data = await res.json();
          if (data.map && langRef.current === code) {
            setDict((prev) => {
              const next = { ...prev, ...data.map };
              cacheSet(code, next);
              return next;
            });
          }
          if (data.error) {
            setError(data.error);
            break;
          }
        }
      } catch {
        setError("Could not reach the translation service.");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const setLang = useCallback(
    (code: string) => {
      setLangState(code);
      try {
        localStorage.setItem("wd_lang", code);
      } catch {}
      applyDirection(code);
      if (code === "en") {
        setDict({});
        return;
      }
      const cached = cacheGet(code);
      setDict(cached);
      const missing = [...registry].filter((s) => !cached[s]);
      fetchTranslations(code, missing);
    },
    [applyDirection, fetchTranslations]
  );

  // Restore the saved language on first load.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("wd_lang");
      if (saved && saved !== "en" && LANGS.some((l) => l.code === saved)) {
        setLangState(saved);
        applyDirection(saved);
        const cached = cacheGet(saved);
        setDict(cached);
        // Complete coverage for THIS page too: anything in the app catalogue
        // that is not yet cached gets translated right away.
        const missing = [...registry].filter((s) => !cached[s]);
        if (missing.length) fetchTranslations(saved, missing);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sweep strings that appeared after the initial fetch (lazy screens/modals).
  useEffect(() => {
    if (lang === "en") return;
    const id = setInterval(() => {
      if (pending.size === 0) return;
      const batch = [...pending];
      pending.clear();
      fetchTranslations(lang, batch);
    }, 1500);
    sweepTimer.current = undefined;
    return () => clearInterval(id);
  }, [lang, fetchTranslations]);

  const t = useCallback(
    (s: string): string => {
      registry.add(s);
      if (lang === "en") return s;
      const hit = dict[s];
      if (hit) return hit;
      pending.add(s);
      return s;
    },
    [lang, dict]
  );

  // Memoize the context value so a `busy`/`error` toggle (or any provider
  // re-render) does not hand every useI18n consumer in the tree a brand-new
  // object and force a full-app re-render on each translate sweep.
  const value = useMemo(
    () => ({ lang, setLang, t, busy, error }),
    [lang, setLang, t, busy, error]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
