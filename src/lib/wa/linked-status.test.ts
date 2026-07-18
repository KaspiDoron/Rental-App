import { describe, it, expect } from "vitest";
import { isLinkedFromStatus } from "./linked-status";

describe("isLinkedFromStatus (connection-honesty: connecting != linked)", () => {
  it("treats a durable open status as linked", () => {
    expect(isLinkedFromStatus("open")).toBe(true);
  });

  it("treats an unreadable store (unknown) as linked - fail SAFE, never re-link a paired user on a DB blip", () => {
    expect(isLinkedFromStatus("unknown")).toBe(true);
  });

  it("treats a not-yet-opened 'connecting' row as NOT linked (the false-connected pairing bug)", () => {
    // connectInstance writes a "connecting" row the moment it hands back the
    // pairing code, BEFORE the user enters it. Reporting that as connected made
    // the 3s status poll clear the code and strand the user "linked but never open".
    expect(isLinkedFromStatus("connecting")).toBe(false);
  });

  it("treats a genuinely-absent session (null) as NOT linked", () => {
    expect(isLinkedFromStatus(null)).toBe(false);
  });

  it("treats any other transient socket phase as NOT linked", () => {
    for (const s of ["close", "qr", "refused", ""]) {
      expect(isLinkedFromStatus(s)).toBe(false);
    }
  });
});
