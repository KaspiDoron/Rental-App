import { describe, it, expect } from "vitest";
import { identifyVehicles, judgeVehicle, judgeReply, pairPricesWithVehicles } from "./identity";
import { assessPrice, assessReply, pickOurPrice, questionFor } from "./resolution";
import { catalogueFactsFor, findModels } from "./catalogue";
import { disqualifyingKeys, describeSpec } from "./spec";

// The traveller declared this in both live threads, and their licence
// disclaimer covers exactly it.
const SCOOTER_125 = {
  class: "scooter" as const,
  displacementCc: 125,
  transmission: "automatic" as const,
};

// The two replies that put a bike the traveller cannot ride on screen as BEST
// PRICE, typed out exactly as the shops sent them.
const JOHS =
  "for the Honda beat sir 400 pesos sir for the honda click 125 500 pesos since you rent for 4 days";
const COYOTE =
  "Regular price sir is 700 per day you can check, I already gave 500 for you. If you want 110cc 400 per day";

describe("the two replies that shipped the wrong bike", () => {
  it("Joh's Matics: 400 belongs to the BeAT, 500 belongs to the Click 125", () => {
    const paired = pairPricesWithVehicles(
      JOHS,
      [
        { pricePerDay: 400, index: JOHS.indexOf("400") },
        { pricePerDay: 500, index: JOHS.indexOf("500") },
      ],
      SCOOTER_125
    );
    expect(paired[0].judgement.identity.model?.name).toBe("Honda BeAT");
    expect(paired[0].judgement.verdict).toBe("mismatch");
    expect(paired[1].judgement.identity.model?.name).toBe("Honda Click 125");
    expect(paired[1].judgement.verdict).toBe("match");
  });

  it("Joh's Matics: the traveller's price is 500, not the cheaper 400", () => {
    const pick = pickOurPrice(
      JOHS,
      SCOOTER_125,
      [
        { pricePerDay: 400, index: JOHS.indexOf("400") },
        { pricePerDay: 500, index: JOHS.indexOf("500") },
      ]
    );
    expect(pick?.price).toBe(500);
    expect(pick?.assessment.status).toBe("confirmed");
  });

  it("Coyote Way: the shop typed 110cc next to 400 - that price is not ours", () => {
    const a = assessPrice(COYOTE, SCOOTER_125, {
      pricePerDay: 400,
      index: COYOTE.indexOf("400"),
    });
    expect(a.status).not.toBe("confirmed");
    expect(a.canPresent).toBe(false);
    expect(a.canBargain).toBe(false);
  });

  it("Coyote Way: 400 is never picked over the 500 that was quoted to us", () => {
    const pick = pickOurPrice(COYOTE, SCOOTER_125, [
      { pricePerDay: 700, index: COYOTE.indexOf("700") },
      { pricePerDay: 500, index: COYOTE.indexOf("500") },
      { pricePerDay: 400, index: COYOTE.indexOf("400") },
    ]);
    expect(pick?.price).not.toBe(400);
  });

  it("a BeAT is 110cc even though the shop never typed a number", () => {
    const v = identifyVehicles("do you have the honda beat available")[0];
    expect(v.attributes.displacementCc?.value).toBe(110);
    expect(v.attributes.displacementCc?.evidence).toBe("catalogue");
  });
});

describe("unresolved is not a match - the default that caused all of it", () => {
  it("a price with no vehicle named at all cannot be presented", () => {
    const a = assessPrice("500 per day sir", SCOOTER_125, { pricePerDay: 500, index: 0 });
    expect(a.status).toBe("needs-confirmation");
    expect(a.canPresent).toBe(false);
    expect(a.question).toMatch(/125cc/);
  });

  it("a nameplate sold in several sizes does NOT settle the size", () => {
    // A bare "Click" is 125 or 160 - the catalogue refuses to guess.
    const a = assessReply("we have the Honda Click available", SCOOTER_125);
    expect(a.status).toBe("needs-confirmation");
    expect(a.missing).toContain("displacementCc");
  });

  it("but a stated size beats the catalogue's uncertainty", () => {
    const a = assessReply("we have the Honda Click 125 available", SCOOTER_125);
    expect(a.status).toBe("confirmed");
    expect(a.canPresent).toBe(true);
  });

  it("what the shop types about THIS bike always outranks general knowledge", () => {
    const v = identifyVehicles("honda beat 125cc version")[0];
    expect(v.attributes.displacementCc?.value).toBe(125);
    expect(v.attributes.displacementCc?.evidence).toBe("stated");
  });
});

describe("the same machinery, other attributes", () => {
  it("a semi-automatic underbone fails an automatic-scooter request", () => {
    // A Wave conflicts on BOTH counts - it is a geared motorbike, not a
    // twist-and-go scooter - and every conflict is recorded, not just the first.
    const j = judgeReply("we have the Honda Wave 125", SCOOTER_125);
    expect(j.verdict).toBe("mismatch");
    expect(j.conflicts.map((c) => c.key).sort()).toEqual(["class", "transmission"]);
  });

  it("a motorbike fails a scooter request even at the right size", () => {
    const j = judgeReply("Suzuki Raider 150 available", { class: "scooter", displacementCc: 150 });
    expect(j.verdict).toBe("mismatch");
    expect(j.conflicts.some((c) => c.key === "class")).toBe(true);
  });

  it("CARS: too few seats is the same kind of error as the wrong engine", () => {
    const want = { class: "car" as const, seats: 7 };
    const j = judgeReply("we have the Toyota Vios", want);
    expect(j.verdict).toBe("mismatch");
    expect(j.conflicts[0].key).toBe("seats");
  });

  it("CARS: a big enough car passes on seats", () => {
    expect(judgeReply("Toyota Avanza available", { class: "car", seats: 7 }).verdict).toBe("match");
  });

  it("CARS: an uncatalogued nameplate blocks and asks rather than guessing", () => {
    const a = assessReply("we have a Perodua Bezza", { class: "car", seats: 5 });
    expect(a.status).toBe("needs-confirmation");
    expect(a.question).toMatch(/seat/i);
  });

  it("only DECLARED attributes can block - an unstated seat count never does", () => {
    expect(disqualifyingKeys({ class: "scooter", displacementCc: 125 })).toEqual([
      "class",
      "displacementCc",
    ]);
    expect(assessReply("Honda Click 125", { class: "scooter", displacementCc: 125 }).status).toBe(
      "confirmed"
    );
  });
});

describe("a reply can carry the wrong vehicle AND the right one", () => {
  it("Joh's Matics is workable, not a dead end - the Click 125 is right there", () => {
    expect(assessReply(JOHS, SCOOTER_125).status).toBe("confirmed");
  });

  it("a shop with only the wrong vehicle is a dead end, honestly", () => {
    const a = assessReply("sorry sir we only have the Honda Beat", SCOOTER_125);
    expect(a.status).toBe("wrong-vehicle");
    expect(a.travellerNote).toMatch(/Honda BeAT/);
  });
});

describe("the question the agent asks", () => {
  it("names the missing attribute and what the traveller needs", () => {
    const j = judgeReply("500 per day", SCOOTER_125);
    const q = questionFor(SCOOTER_125, j);
    expect(q).toMatch(/125cc/);
    expect(q).toMatch(/automatic 125cc scooter/);
  });

  it("acknowledges the wrong vehicle and asks for the right one", () => {
    const j = judgeReply("only the Honda Beat sir", SCOOTER_125);
    expect(questionFor(SCOOTER_125, j)).toMatch(/Honda BeAT/);
    expect(questionFor(SCOOTER_125, j)).toMatch(/Do you have one/i);
  });

  it("never repeats a price back as if it were ours", () => {
    const j = judgeReply("400 per day for the beat", SCOOTER_125);
    expect(questionFor(SCOOTER_125, j)).not.toContain("400");
  });

  it("reads like a person, not a template", () => {
    const j = judgeReply("500 per day", SCOOTER_125);
    expect(questionFor(SCOOTER_125, j)).toContain("an automatic");
  });
});

describe("the catalogue as ground truth for the model", () => {
  it("renders only the models a reply actually names", () => {
    const facts = catalogueFactsFor(JOHS);
    expect(facts).toMatch(/Honda BeAT = 110cc/);
    expect(facts).toMatch(/Honda Click 125 = 125cc/);
    expect(facts).not.toMatch(/Yamaha/);
  });

  it("a longer name masks the shorter one inside it", () => {
    const names = findModels("honda click 125 please").map((h) => h.model.name);
    expect(names).toEqual(["Honda Click 125"]);
  });

  it("word boundaries hold - 'beat' does not fire inside another word", () => {
    expect(findModels("we are beating the heat").length).toBe(0);
    expect(findModels("advance booking only").length).toBe(0);
  });

  it("describes a spec the way a traveller would say it", () => {
    expect(describeSpec(SCOOTER_125)).toBe("automatic 125cc scooter");
    expect(describeSpec({ class: "car", seats: 7 })).toBe("7-seat car");
  });
});

describe("judgeVehicle is total - it never throws on odd input", () => {
  it("handles an empty reply", () => {
    expect(assessReply("", SCOOTER_125).status).toBe("needs-confirmation");
  });
  it("handles a declaration with nothing in it", () => {
    expect(judgeReply("Honda Beat 110", {}).verdict).toBe("match");
  });
  it("ignores numbers that cannot be engines", () => {
    const v = identifyVehicles("open 8am, 5000 pesos deposit");
    expect(v.every((x) => x.attributes.displacementCc === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. Every one of these is a place the gate must be consulted; without
// them the architecture is a library nobody calls, which is precisely how a
// 110cc reached the screen with `matchesSpec` sitting right there.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the gate is actually in the path", () => {
  it("extraction runs it, and the catalogue outranks the model's opinion", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/vehicle\/resolution/);
    expect(loop).toMatch(/pickOurPrice/);
    expect(loop).toMatch(/vehicleAssessment/);
  });

  it("the model is TOLD what a nameplate is instead of inferring it", () => {
    expect(readCode("src/lib/agents.ts")).toMatch(/catalogueFactsFor/);
  });

  it("an unconfirmed vehicle makes confirm-vehicle legal, ahead of bargain", () => {
    const policy = readCode("src/lib/spte/policy.ts");
    expect(policy).toMatch(/vehicleStatus === "needs-confirmation"/);
    expect(policy.indexOf("confirm-vehicle")).toBeLessThan(policy.indexOf('moves.push("bargain")'));
  });

  it("a rail - not a prompt - stops a bargain on an unsettled vehicle", () => {
    const rails = readCode("src/lib/spte/rails.ts");
    expect(rails).toMatch(/vehicleStatus/);
    expect(rails).toMatch(/vehicle-identity/);
    // Ahead of the numeric rail: the vehicle is settled before the number is.
    // Ahead of the numeric rail's CALL SITE (not its import): the vehicle is
    // settled before a single number is even looked at.
    expect(rails.indexOf("vehicle-identity")).toBeLessThan(rails.indexOf("checkOutboundNumbers({"));
  });

  it("presentation refuses anything that is not confirmed", () => {
    const pres = readCode("src/lib/offer-presentation.ts");
    expect(pres).toMatch(/vehicleStatus && offer\.vehicleStatus !== "confirmed"/);
  });

  it("the verdict reaches the client, derived rather than stored", () => {
    const replies = readCode("src/app/api/replies/route.ts");
    expect(replies).toMatch(/assessPrice/);
    expect(replies).toMatch(/vehicleStatus/);
    // No migration: nothing new is written to the offers table.
    expect(replies).not.toMatch(/vehicle_status/);
  });

  it("the card says what is being confirmed instead of hiding it", () => {
    expect(readCode("src/components/VendorCard.tsx")).toMatch(/offer\.vehicleNote/);
  });
});
