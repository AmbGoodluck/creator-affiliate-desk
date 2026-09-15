-- Schedule the engine. Run this ONCE, after the three edge functions are deployed.
-- The functions no-op until you set COMPOSIO_API_KEY / ANTHROPIC_API_KEY, so scheduling early is safe.
-- Auth: the legacy anon JWT below is a public key and only satisfies verify_jwt; the functions use the
-- injected service role internally to do privileged work.

select cron.schedule('outreach-send-due', '*/30 * * * *', $$
  select net.http_post(
    url := 'https://aiyfpbyrvpgtuuenrfph.supabase.co/functions/v1/send-due',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpeWZwYnlydnBndHV1ZW5yZnBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzAzMjIsImV4cCI6MjA5NjU0NjMyMn0.2f7tUkCCrUK84a698uzKutVh889S0hSt93pNMcTbOGk'),
    body := '{}'::jsonb) $$);

select cron.schedule('outreach-poll-replies', '15,45 * * * *', $$
  select net.http_post(
    url := 'https://aiyfpbyrvpgtuuenrfph.supabase.co/functions/v1/poll-replies',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpeWZwYnlydnBndHV1ZW5yZnBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzAzMjIsImV4cCI6MjA5NjU0NjMyMn0.2f7tUkCCrUK84a698uzKutVh889S0hSt93pNMcTbOGk'),
    body := '{}'::jsonb) $$);

select cron.schedule('outreach-draft-reply', '20,50 * * * *', $$
  select net.http_post(
    url := 'https://aiyfpbyrvpgtuuenrfph.supabase.co/functions/v1/draft-reply',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpeWZwYnlydnBndHV1ZW5yZnBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzAzMjIsImV4cCI6MjA5NjU0NjMyMn0.2f7tUkCCrUK84a698uzKutVh889S0hSt93pNMcTbOGk'),
    body := '{}'::jsonb) $$);

select cron.schedule('outreach-purge', '17 3 * * *', $$ select public.outreach_purge() $$);

-- To stop the engine later:
-- select cron.unschedule('outreach-send-due');
-- select cron.unschedule('outreach-poll-replies');
-- select cron.unschedule('outreach-draft-reply');
-- select cron.unschedule('outreach-purge');
