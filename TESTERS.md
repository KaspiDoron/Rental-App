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
3. **WhatsApp host**: check Admin -> Keys -> Service health: "WhatsApp hosts"
   must be green. Free-tier hosts sleep - keep the cron-job.org ping on
   `https://<your-app>/api/wa/ping` every 5-10 minutes (it also delivers
   queued messages while nobody has the app open).
4. **AI + Maps**: same health panel - "AI providers" and "Google Maps" green.
5. Run `supabase/schema.sql` once in the Supabase SQL editor (idempotent) -
   this test build added the `vendor_tag_signals` and `agent_traces` tables.

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
