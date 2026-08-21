-- PERFORMANCE INDEXES (owner report 6, wave L1). Additive + idempotent:
-- paste once in the Supabase SQL editor; safe to re-run for ever.
--
-- WHY: ~15 hot read sites scope whatsapp_messages by the RECEIVING user
-- (raw->>'receiver' for inbound privacy scoping, raw->>'sender' for outbound
-- ownership) and then walk received_at - but the table only has btree indexes
-- on plain columns, so every poll, thread read, session-boundary check and
-- recovery sweep walks received_at backwards testing the JSON on each row.
-- Fine at hundreds of rows; a seq-scan tax on every request at hundreds of
-- thousands. These are ordinary expression indexes - PostgREST query shapes
-- (raw->>receiver=eq.X&order=received_at.desc) match them exactly.

create index if not exists wa_msgs_receiver_at
  on public.whatsapp_messages ((raw->>'receiver'), received_at desc);

create index if not exists wa_msgs_sender_at
  on public.whatsapp_messages ((raw->>'sender'), received_at desc);

-- The per-thread joins additionally pin the shop's number; these two make
-- "this user's conversation with this shop, newest first" an index walk.
create index if not exists wa_msgs_receiver_from_at
  on public.whatsapp_messages ((raw->>'receiver'), from_number, received_at desc);

create index if not exists wa_msgs_sender_to_at
  on public.whatsapp_messages ((raw->>'sender'), to_number, received_at desc);

-- The reply feed and Trips scope vendor_replies by user + recency on every
-- poll (order=created_at.desc&limit=40).
create index if not exists vendor_replies_user_at
  on public.vendor_replies (user_email, created_at desc);

-- The activity/risk feeds and the ops panels read agent_events by user +
-- recency; the doctor additionally filters kind.
create index if not exists agent_events_user_at
  on public.agent_events (user_email, created_at desc);
