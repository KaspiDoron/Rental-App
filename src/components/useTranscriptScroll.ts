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

/** Cheap identity for a transcript: nothing else in a message body changes
 *  after it lands, so the count plus first/last ids settle it. */
function signature(list: ThreadMsg[]): string {
  if (!list.length) return "0";
  return `${list.length}|${list[0].id}|${list[list.length - 1].id}|${
    list[list.length - 1].text.length
  }`;
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
