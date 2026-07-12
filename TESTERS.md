# WheelDeal - Beta Tester Guide (25-user test)

Copy-paste the "For your testers" section to your group. The owner pre-flight
comes first - five minutes that make the whole test smooth.

## Owner pre-flight (before inviting anyone)

1. **Invite list**: Admin -> Users -> "Private beta - invite list": add each
   tester's email (and pick their plan: free/pro/ultra). Only listed emails
   can sign up or log in - everyone else is locked out.
2. **Email codes**: Admin -> Keys: make sure a Gmail App Password
   (GMAIL_USER + GMAIL_APP_PASSWORD) or Brevo/Resend key is set and its
   "Test API" passes. With a key set, signups require a 6-digit email code.
   With NO email key, invited testers enter directly without a code (by
   design) - fine for a private test.
3. **SESSION_SECRET (required in production)**: set a strong value (>= 16
   chars) in the host env. Without it the app now refuses to create/validate
   login sessions (this prevents forged owner cookies) - so logins will fail
   until it is set. Rotate it if it was ever shared.
4. **WhatsApp host + secured ping**: check Admin -> Keys -> Service health:
   "WhatsApp hosts" must be green. Free-tier hosts sleep - keep a cron-job.org
   ping running. The ping URL now carries a security token, so DON'T invent
   one: on the same Keys page there's a "⏰ Cron keep-alive URL" card - tap
   Copy and paste that exact URL into cron-job.org (every 5-10 min). The token
   is derived from SESSION_SECRET; an unauthenticated ping is rejected. The
   ping also delivers queued messages while nobody has the app open.
5. **Meta webhook signature (only if using the official Cloud API)**: set
   `WHATSAPP_APP_SECRET` in Admin -> Keys so inbound webhooks are signature-
   verified. The per-user Evolution path is unaffected.
6. **AI + Maps**: same health panel - "AI providers" and "Google Maps" green.
   - **Google Maps key is what powers location autocomplete everywhere** (the
     hotel/stay box, booking delivery address, profile home city, and the admin
     area fields). Without it, typing falls back to OpenStreetMap, which is
     rate-limited from cloud IPs, so suggestions can look empty - set the key.
   - A **Gemini** key is recommended: it grounds the market-floor "going rate"
     box in REAL web search and lets the agents READ shop photos (price sheets
     vs the actual vehicle). Market floors now refresh every 3 weeks per area.
7. **Reply alerts (optional, all plans)**: to notify testers when a shop replies
   even with the app closed, generate a VAPID key pair (`npx web-push
   generate-vapid-keys`) and paste both into Admin -> Keys (`VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY`). Testers then tap "Notify me" on the search screen.
   Without the keys the opt-in simply hides - nothing breaks.
8. Run `supabase/schema.sql` once in the Supabase SQL editor (idempotent) -
   this build added `push_subscriptions`, deposit columns
   (`deposit_type`/`deposit_amount`/`deposit_currency`) on `offers` /
   `vendor_replies`, and earlier `vendor_tag_signals`, `agent_traces`,
   `wa_processed` and the rental columns.

**New owner tools in this build (Admin -> Agents):** the negotiation brain is
now a data-driven, editable **branching engine** (rename any agent, reorder or
disable stages, add "when X -> then Y" edge rules), a **dry-run simulator**
(type a hypothetical shop reply or pick a preset scenario and watch every stage
run, WITHOUT sending anything), and a **single-prompt tester**. Deposits a shop
asks for now show as a precise tag next to the price ("Passport", "THB 3,000
cash"). Testers waiting on shops can play the built-in mini-game.

## For your testers (copy-paste)

Hi! You're one of 25 people testing WheelDeal - an app whose AI agents find
and bargain the cheapest scooter/car rentals near you, on your own WhatsApp.

**Getting in (2 minutes):**
1. Open <YOUR-APP-URL> on your phone and tap **Sign up**.
2. Use the SAME email I invited you with. Choose ANY password you like
   (6+ characters) - there is no shared password; this password is yours,
   remember it for next time. Or tap "Continue with Google" if invited on
   your Gmail address.
3. Enter your phone number with the country code (e.g. +91..., +972...).
4. If asked, type the 6-digit code we email you.
5. **Connect WhatsApp** (the important step): the app shows a pairing code.
   In WhatsApp: Settings -> Linked Devices -> Link a Device -> "Link with
   phone number instead" -> type the code. This is how the agents message
   shops AS YOU - shops see a real traveller.
6. Skip the plans screen ("Maybe later") - you already have your test plan.

**Using it:** type what you want to rent ("125cc scooter, 3 days"), set your
hotel/area, tap "Find my deal", then "Ask for price" on shops (or "Bargain
all"). Replies land in the app automatically - the agents answer, compare
prices between shops and bargain for you. You always decide the booking.

**If something looks wrong**, tap the Feedback tab and write 1-2 sentences -
every report lands straight on my desk.

## Notes for the owner

- Forgot password: the login page's "Forgot password?" emails a temporary
  password (needs the email key).
- A tester removed from the invite list is signed out automatically on
  their next action.
- Watch conversations live in Admin -> Agents -> "Live decisions": every
  message decision, stage by stage.
- Per-tester WhatsApp pacing is automatic (anti-ban engine); a tester's
  queued messages are visible to them on the search page and to you in the
  data explorer (wa_outbox).
