import type { Guide } from "./types";

const guide: Guide = {
  slug: "scooter-handover-checklist",
  title: "The five-minute handover checklist that protects your deposit",
  summary:
    "A slow walk-around video and a dozen photos, taken openly in front of the shop, settle almost every deposit dispute before it starts.",
  updated: "2026-08-13",
  category: "risk-safety",
  related: [
    "rental-scam-warning-signs",
    "rental-contract-checklist",
    "scooter-rental-cash-deposit",
  ],
  sections: [
    {
      heading: "Why five minutes at pickup beats an hour at return",
      blocks: [
        {
          kind: "p",
          text: "Almost every deposit argument follows the same script: you bring the bike back, someone points at a mark, and now it is your word against theirs about whether the mark was there when you left. At that point you have no leverage. The shop holds your deposit, they know the bike, and you are probably leaving town in a day or two - which they also know.",
        },
        {
          kind: "p",
          text: "The entire argument evaporates if you can pull out your phone and show a timestamped video of that exact panel, taken in their doorway, on the day you collected the bike. Not because it wins a debate - because the debate never starts. A shop that was going to try it on picks an easier target, and an honest shop is simply relieved you both have a record.",
        },
        {
          kind: "p",
          text: "This costs you five minutes at handover. There is no other five minutes in the whole rental that buys you as much.",
        },
      ],
    },
    {
      heading: "The walk-around video",
      blocks: [
        {
          kind: "p",
          text: "Start with one continuous video, not photos. Walk slowly around the whole bike - a full lap takes under a minute - keeping the camera close enough that scratches are visible. Crouch for the lower fairings and the exhaust, which is where old drop damage usually lives. Get the number plate in frame at the start so there is no question which bike the footage shows.",
        },
        {
          kind: "p",
          text: "The video is your safety net because it is continuous: nobody can claim you photographed one side and skipped the other. The photos that follow are the detail evidence you will actually zoom into if a specific mark is disputed.",
        },
        {
          kind: "list",
          items: [
            "Odometer reading - some shops charge for distance, and it also proves which day the footage is from.",
            "Fuel gauge - so 'return it at the same level' has a level to point at.",
            "Every existing scratch, dent, crack, or scuff you can find, close up, one photo each.",
            "Both tyres, close enough to see the tread. Bald tyres are a safety problem now and a blame problem later.",
            "Both mirrors, both levers, and the seat - the small parts that are cheap to break and easy to bill for.",
            "The helmet they hand you, inside and out, since it is part of what you return.",
          ],
        },
      ],
    },
    {
      heading: "Do the checks that matter before you ride away",
      blocks: [
        {
          kind: "p",
          text: "The camera covers the cosmetic side. Spend the second half of your five minutes on the parts that keep you alive, because a fault you discover in traffic is a much worse place to discover it.",
        },
        {
          kind: "p",
          text: "Sit on the bike and squeeze both brakes hard - the lever should firm up well before it reaches the grip. Turn the key and check the headlight, the brake light with each lever, both indicators, and the horn. Bounce your weight on the seat once or twice; a fork that clunks or a wobble in the steering head is a reason to ask for a different bike, not a discount.",
        },
        {
          kind: "table",
          headers: ["Check", "How", "If it fails"],
          rows: [
            ["Front and rear brakes", "Squeeze hard while pushing the bike forward", "Different bike. Not negotiable."],
            ["Lights and horn", "Key on, cycle everything once", "Ask them to fix it now - it is usually a bulb or a fuse"],
            ["Tyre tread", "Look and press; slicks and cracks are obvious", "Different bike, especially in rainy season"],
            ["Odometer and fuel", "Photograph both", "Nothing fails - this is your record"],
            ["Mirrors", "Adjust from the seat", "Ask for a tighten; loose mirrors will not hold on rough roads"],
          ],
        },
      ],
    },
    {
      heading: "Do it openly, in front of the staff",
      blocks: [
        {
          kind: "p",
          text: "There is a temptation to film discreetly, as if documenting the bike were an accusation. It is the opposite. Done openly, the walk-around is a statement that you are careful, that you expect the return to be by the book, and that any later claim will be checked against footage both sides know exists. Shops rent to hundreds of tourists; the ones who film are remembered as the ones not to bill for phantom scratches.",
        },
        {
          kind: "p",
          text: "Better still, narrate it. Point at a scratch, say it out loud, and let the staff member nod on camera. Most will join in and start pointing out marks themselves - at which point you and the shop are building the same record together, which is exactly the position you want to be in.",
        },
        {
          kind: "p",
          text: "If anyone objects to you filming their bike before you take responsibility for it, treat that as information. An honest shop has nothing to lose from your footage and something to gain.",
        },
      ],
    },
    {
      heading: "Keep the media until the deposit is back in your hand",
      blocks: [
        {
          kind: "p",
          text: "The record is only worth something while a claim is still possible. Do not delete the video to free up space mid-trip, and do not assume a smooth-looking return is the end of it - hold everything until the deposit has actually been returned, in cash or back on your card, and you have walked away.",
        },
        {
          kind: "p",
          text: "Repeat the ritual in reverse at drop-off: one lap of video showing the bike's condition, the odometer, and the fuel gauge, filmed before you hand over the keys. A dispute that surfaces after you have left - a message a week later about damage - is answered by the same footage.",
        },
        {
          kind: "callout",
          text: "If your phone might be lost, stolen, or drowned during the trip - all realistic on a scooter holiday - back the handover media up to cloud storage the same day. Evidence that sank with your phone protects nobody.",
        },
      ],
    },
  ],
  faq: [
    {
      q: "Will the shop be offended if I film the bike?",
      a: "Very rarely, and mostly the opposite - it signals you are a careful renter. Doing it openly and narrating it usually turns it into a joint inspection. A shop that objects to being filmed is telling you something useful.",
    },
    {
      q: "Is a video really enough to win a damage dispute?",
      a: "It almost never has to win anything - it prevents the dispute from being raised at all. A claim about pre-existing damage depends on there being no record; once footage exists and the shop knows it, the claim usually just does not happen.",
    },
    {
      q: "What if I find damage after I have already ridden away?",
      a: "Photograph it immediately and message the shop the photo the same day, referencing the handover. A mark reported an hour after pickup with your walk-around footage behind it is a very different conversation from one discovered at return.",
    },
  ],
};

export default guide;
