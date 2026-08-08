import { describe, it, expect } from "vitest";
import {
  worseOf,
  worstOf,
  headerVerdict,
  fromRead,
  emptyTile,
  unavailableTile,
  ratioValue,
  hasEnoughSample,
  receiptLiveness,
  rollupStale,
  truncationNote,
  fleetTile,
  MIN_RATIO_SAMPLE,
  type Tile,
} from "./risk-verdict";

const tile = (id: string, state: Tile["state"]): Tile => ({ id, label: id, state });

describe("severity order - dark outranks warn", () => {
  // An unverifiable fleet is worse than a known-degraded one: with warn you
  // know the size of the problem, with dark you know nothing at all.
  it("dark beats warn and ok", () => {
    expect(worseOf("warn", "dark")).toBe("dark");
    expect(worseOf("ok", "dark")).toBe("dark");
  });

  it("critical still beats dark - a confirmed restriction is worse than not knowing", () => {
    expect(worseOf("dark", "critical")).toBe("critical");
  });

  it("empty is the LEAST severe - it is a real reading of nothing yet", () => {
    expect(worseOf("empty", "ok")).toBe("ok");
    expect(worseOf("empty", "warn")).toBe("warn");
  });

  it("worstOf scans a whole panel", () => {
    expect(worstOf([tile("a", "ok"), tile("b", "warn"), tile("c", "ok")])).toBe("warn");
    expect(worstOf([tile("a", "ok"), tile("b", "dark")])).toBe("dark");
    expect(worstOf([])).toBe("empty");
  });
});

describe("E6/E1 header verdict", () => {
  it("is the WORST tile, never an average", () => {
    const tiles = [tile("a", "ok"), tile("b", "ok"), tile("c", "ok"), tile("d", "critical")];
    // An average would hide the critical behind three healthy tiles.
    expect(headerVerdict(tiles).state).toBe("critical");
  });

  it("goes dark once 30% of tiles are dark, whatever the readable ones say", () => {
    const tiles = [tile("a", "ok"), tile("b", "ok"), tile("c", "dark"), tile("d", "dark")];
    const v = headerVerdict(tiles);
    expect(v.metersUnverified).toBe(true);
    expect(v.state).toBe("dark");
    expect(v.darkCount).toBe(2);
  });

  it("below the threshold a single dark tile does not darken the header", () => {
    const tiles = [tile("a", "ok"), tile("b", "ok"), tile("c", "ok"), tile("d", "dark")];
    const v = headerVerdict(tiles);
    expect(v.metersUnverified).toBe(false);
    expect(v.state).toBe("dark"); // worst-of still surfaces it
  });

  it("critical survives the dark override - it is not downgraded", () => {
    const tiles = [tile("a", "critical"), tile("b", "dark"), tile("c", "dark")];
    expect(headerVerdict(tiles).state).toBe("critical");
  });

  it("an empty panel is not 'unverified'", () => {
    expect(headerVerdict([]).metersUnverified).toBe(false);
  });
});

describe("E1 - REPRODUCTION: a failed read is dark, never zero", () => {
  // This is the Command Center bug exactly: nine reads ending .catch(() => [])
  // so an unreachable database produced zero alerts and a green panel.
  it("null rows produce a dark tile that carries no number", () => {
    const t = fromRead("bugs", "Open bugs", null, (rows) => ({
      state: rows.length ? "warn" : "ok",
      value: String(rows.length),
    }));
    expect(t.state).toBe("dark");
    expect(t.value).toBeUndefined();
    expect(t.reason).toBe("could not be read");
    expect(t.action).toBeTruthy();
  });

  it("THE OLD BEHAVIOUR would have rendered ok/0 - proving the fix matters", () => {
    // Simulating `.catch(() => [])`: the failure became an empty array, and an
    // empty array is indistinguishable from "nothing wrong".
    const asEmptyArray = fromRead("bugs", "Open bugs", [], (rows) => ({
      state: rows.length ? "warn" : "ok",
      value: String(rows.length),
    }));
    expect(asEmptyArray.state).toBe("ok");
    expect(asEmptyArray.value).toBe("0");
    // ...which is why the read must hand us null instead.
  });

  it("a successful read renders normally", () => {
    const t = fromRead("bugs", "Open bugs", [1, 2, 3], (rows) => ({
      state: rows.length > 2 ? "warn" : "ok",
      value: String(rows.length),
    }));
    expect(t.state).toBe("warn");
    expect(t.value).toBe("3");
  });
});

describe("E4 - the sample floor refuses to render a ratio from nothing", () => {
  it("below the floor it shows the fraction, not a percentage", () => {
    expect(ratioValue(3, 5)).toBe("3 / 5");
    expect(ratioValue(1, 2, "replies")).toBe("1 / 2 replies");
  });

  it("at and above the floor it shows a percentage", () => {
    expect(ratioValue(4, 8)).toBe("50%");
    expect(ratioValue(30, 100)).toBe("30%");
  });

  it("the floor is 8 - the same n the delivery breaker needed and never checked", () => {
    expect(MIN_RATIO_SAMPLE).toBe(8);
    expect(hasEnoughSample(7)).toBe(false);
    expect(hasEnoughSample(8)).toBe(true);
  });
});

describe("E3 - receipts that stop must go dark, not read as idle", () => {
  const NOW = Date.parse("2026-08-08T12:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it("nothing sent means no receipt is due - empty, not dark", () => {
    expect(receiptLiveness(null, false, NOW)).toBe("empty");
  });

  it("REPRODUCTION: sent recently but no receipt ever seen is DARK", () => {
    // The old meter would have reported 0 delivered and called it idle.
    expect(receiptLiveness(null, true, NOW)).toBe("dark");
  });

  it("a fresh receipt is ok", () => {
    expect(receiptLiveness(ago(30 * 60_000), true, NOW)).toBe("ok");
  });

  it("silence beyond the window is dark even though sends continued", () => {
    expect(receiptLiveness(ago(7 * 3600_000), true, NOW)).toBe("dark");
  });

  it("an unparseable timestamp is dark, not ok", () => {
    expect(receiptLiveness("not-a-date", true, NOW)).toBe("dark");
  });
});

describe("E8 - a stale rollup darkens the whole panel", () => {
  const NOW = Date.parse("2026-08-08T12:00:00Z");
  const HOUR = 3600_000;

  it("a fresh bucket is not stale", () => {
    expect(rollupStale(new Date(NOW - 30 * 60_000).toISOString(), HOUR, NOW).stale).toBe(false);
  });

  it("older than two periods is stale", () => {
    expect(rollupStale(new Date(NOW - 3 * HOUR).toISOString(), HOUR, NOW).stale).toBe(true);
  });

  it("no bucket at all is stale, and the age is unknown rather than 0", () => {
    const r = rollupStale(null, HOUR, NOW);
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBeNull();
  });
});

describe("E9 - truncation is stated, so 12 does not read as all of them", () => {
  it("marks a capped list", () => {
    expect(truncationNote(50, 50)).toBe("showing first 50");
  });
  it("says nothing when the list fit", () => {
    expect(truncationNote(12, 50)).toBeUndefined();
  });
});

describe("E7 - an empty fleet is empty, not healthy", () => {
  it("zero accounts never renders as ok", () => {
    // This is the product's CURRENT state, so getting it wrong would mean the
    // dashboard reports perfect health forever.
    const t = fleetTile("blocks", "Blocked", 0, () => ({ state: "ok", value: "0%" }));
    expect(t.state).toBe("empty");
    expect(t.value).toBeUndefined();
  });

  it("with accounts present the body renders", () => {
    const t = fleetTile("blocks", "Blocked", 12, () => ({ state: "ok", value: "0%" }));
    expect(t.state).toBe("ok");
    expect(t.value).toBe("0%");
  });
});

describe("E5 - a structurally unavailable metric is named, never green", () => {
  it("renders dark with a reason and no value", () => {
    const t = unavailableTile(
      "quota",
      "New-chat quota",
      "not exposed by this WhatsApp client version"
    );
    expect(t.state).toBe("dark");
    expect(t.value).toBeUndefined();
    expect(t.reason).toMatch(/client version/);
  });
});

describe("E2 - genuinely new is its own state", () => {
  it("carries a reason and is the least severe", () => {
    const t = emptyTile("intros", "Introductions", "no searches yet");
    expect(t.state).toBe("empty");
    expect(worstOf([t, tile("x", "ok")])).toBe("ok");
  });
});
