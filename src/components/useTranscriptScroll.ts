"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { ThreadMsg } from "./MessageBubble";

// READING BACK THROUGH A CONVERSATION WAS IMPOSSIBLE.
//
// Both transcripts poll every 5 seconds and did `setMessages(d.messages)` on
// every tick - a brand-new array even when nothing had changed. The sibling
// effect `useEffect(scrollIntoView, [messages])` therefore fired on every tick,
// with no `behavior`, so it was an INSTANT jump inside the scroll container.
//
// Open a shop's thread, scroll up to re-read what they said earlier, and five
// seconds later you are snapped back to the bottom. Forever.
//
// Two rules fix it, and both are needed:
//
//   1. An unchanged transcript keeps its ARRAY IDENTITY, so the effect does not
//      run at all. This is the same reconcile discipline reconcileList /
//      reconcileRecord already apply to the vendor board; the transcripts were
//      simply never brought in line.
//   2. When it HAS changed, only follow if the reader was already at the
//      bottom. Someone reading history has chosen a position, and a new message
//      is not a reason to take it away from them - that is how every chat
//      client behaves.

/**
 * Cheap identity for a transcript.
 *
 * "NOTHING ELSE IN A MESSAGE BODY CHANGES AFTER IT LANDS" WAS TRUE ONCE, AND
 * THE MEDIA READER MADE IT FALSE.
 *
 * A photo's row is stored the instant it arrives; the agents' READING of it
 * (lib/media/reading - the Agentic-summary panel: what was on the price board,
 * the confidence, the honest failure line) is patched onto that SAME row
 * seconds later, asynchronously. Count, first id, last id and the last text's
 * length are all identical before and after, so the signature never moved -
 * and an open transcript kept its old array for the life of the sheet. The
 * summary panel simply never appeared, however long the traveller waited, and
 * closing and reopening the sheet was the only way to see it.
 *
 * So the signature has to include the two things that DO get patched in later:
 * whether a message has a reading yet, and the English gloss stamped by the
 * translation pass. Both are per-message and cheap - one pass over a list
 * bounded at 80 - and both are exactly the "the row changed under us" case the
 * count-based signature was blind to.
 */
function signature(list: ThreadMsg[]): string {
  if (!list.length) return "0";
  let patched = "";
  for (const m of list) {
    // A single character per message: reading present, gloss present, or
    // neither. Enough to move the signature, small enough to build every poll.
    patched += m.reading ? (m.english ? "b" : "r") : m.english ? "e" : ".";
  }
  return `${list.length}|${list[0].id}|${list[list.length - 1].id}|${
    list[list.length - 1].text.length
  }|${patched}`;
}

/**
 * Merge a freshly-polled transcript into the previous one, PRESERVING the old
 * array when nothing meaningful changed.
 *
 * Pass this to setState as an updater so the comparison sees the true previous
 * value rather than a captured one.
 */
export function reconcileMessages(prev: ThreadMsg[] | null, next: ThreadMsg[]): ThreadMsg[] {
  if (prev && signature(prev) === signature(next)) return prev;
  return next;
}

/** How close to the bottom still counts as "following the conversation". About
 *  one message worth of slack, so a half-scrolled bubble does not unstick it. */
const FOLLOW_SLACK_PX = 120;

/**
 * Keep the view pinned to the newest message ONLY while the reader is already
 * there. Returns nothing; wire the two refs and call with the message list.
 *
 * `scrollerRef` is the element with `overflow-y: auto`; `endRef` is the sentinel
 * at the bottom of the list.
 */
export function useFollowNewMessages(
  scrollerRef: RefObject<HTMLElement>,
  endRef: RefObject<HTMLElement>,
  messages: ThreadMsg[] | null
): void {
  // Whether the reader was at the bottom BEFORE this render's messages landed.
  const wasAtBottom = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasAtBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollerRef]);

  useEffect(() => {
    if (!messages) return;
    // First paint has nothing to preserve - land at the newest message, which
    // is what opening a thread should do.
    if (!wasAtBottom.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, endRef]);
}
