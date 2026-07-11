# WheelDeal - Feature Ideation Deck

Each idea states the VALUE it creates and the ASK (effort, dependencies,
running cost). Effort: S = under a day, M = a few days, L = a week+.
Everything here builds on systems that already exist in the codebase - no
idea requires a rewrite.

## Traveller experience

### 1. Deal Score (0-100 on every offer)
- **Value**: one glance answers "is this actually good?" - the offer is
  compared to the market floor, the area's typical price, and other live
  offers in the same search. Turns the market-floor engine into a visible
  superpower and a screenshot people share.
- **Ask**: S. Pure function over data we already have (`floorPriceFor`,
  live offers). Zero running cost.

### 2. Price-drop watch ("tell me if it gets cheaper")
- **Value**: travellers who do not book immediately stay engaged; a shop's
  later counter-offer becomes a push/email that pulls them back into the app.
- **Ask**: M. Reuses the reply loop + email module; needs a small
  `price_watches` table and a cron (Vercel cron is free).

### 3. Trip mode - multi-day itinerary rentals
- **Value**: travellers hopping Samui -> Phangan -> Phuket set up all three
  rentals in one flow; each leg reuses the same RFQ. Nobody else does this.
- **Ask**: M. The RFQ/funnel already supports any location; UI adds a legs
  list and staggered searches.

### 4. Photo-of-the-vehicle request
- **Value**: agents ask the shop for a real photo of the exact vehicle once
  a price lands; the card shows what you actually get. Kills the #1 rental
  scam (bait-and-switch) and boosts booking confidence.
- **Ask**: S-M. Inbound images are already parsed by the vision extractor;
  add one optional agent follow-up + gallery slot on the offer.

### 5. Handover checklist + damage photos
- **Value**: at pickup, the app walks the traveller through photographing
  existing scratches, the odometer and fuel level, timestamped and stored.
  Deposit-dispute armour - a genuine reason to keep the app open offline.
- **Ask**: M. Client-side camera + one storage bucket; no AI needed.

## Monetization

### 6. "Book for me" concierge (Ultra upsell)
- **Value**: after a deal is found, the agent arranges pickup time and
  delivery location in the same thread - the traveller does nothing. The
  clearest possible reason to upgrade; uses the answering branch the agent
  loop already has.
- **Ask**: M. Funnel extension + booking-sheet prefill from the thread.

### 7. Shop-side subscriptions (the other side of the market)
- **Value**: shops that keep winning bookings get offered a dashboard
  (their response stats, win rate vs neighbours, sponsored placement).
  Recurring B2B revenue with data we already collect (`sponsored_shops`,
  response analytics exist).
- **Ask**: L. Shop auth (WhatsApp-code login), a small dashboard page,
  Lemon Squeezy product. Highest revenue ceiling on this list.

### 8. Damage-deposit insurance affiliate
- **Value**: rental insurance (e.g. per-day scooter cover) presented at
  booking; affiliate commission per policy with zero inventory risk.
- **Ask**: S technical (a link + tracking param), M commercial (sign an
  affiliate deal first).

## Growth

### 9. Shareable deal card
- **Value**: after a bargain lands, one tap renders a branded image -
  "My agent talked a Samui shop from 300 to 220 THB/day" - sized for
  Stories/WhatsApp. Every win becomes an ad.
- **Ask**: S. `next/og` image generation is already set up for social cards.

### 10. Referral loop with plan credit
- **Value**: invite a friend, both get a free Pro week when they run their
  first search. Classic travel-buddy virality - this product is naturally
  recommended in hostels.
- **Ask**: M. Referral code on signup (users table), credit logic in the
  plan gate.

### 11. Public area price index (SEO)
- **Value**: auto-generated public pages - "Scooter rental prices in Canggu,
  July 2026: from Rp 50,000/day" - from the market-floor table. Evergreen
  SEO that compounds; each page CTAs into the app.
- **Ask**: M. Static pages over existing `market_floor_prices`; must stay
  aggregate-only (no shop names) to respect data honesty.

## Trust & operations

### 12. Traveller reviews scoped to verified bookings
- **Value**: only someone who actually booked through WheelDeal can rate the
  shop; ratings feed the vendor cards next to Google stars. Proprietary
  review data no competitor can scrape.
- **Ask**: M. Bookings table already links traveller and shop; add a
  post-rental prompt + `shop_reviews` table.

### 13. Agent transparency replay
- **Value**: a "see how your agent negotiated" timeline (every message, the
  reasoning, the floor it anchored to). Builds the trust that an automated
  negotiator needs, and doubles as a support/debug tool.
- **Ask**: S-M. The data is all in `whatsapp_messages` + `agent_events`;
  this is a read-only UI.

## Suggested order

Quick wins first: **1 (Deal Score), 9 (share card), 13 (replay)** - all S,
all visible. Then **2 (price watch)** for retention, **6 (concierge)** for
Ultra conversion, and **7 (shop subscriptions)** as the big swing once shop
volume justifies it.
