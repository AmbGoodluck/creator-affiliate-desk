-- Won => move into accepted. Declined => suppress + soft-archive. Plus a 30-day purge.
create or replace function public.outreach_before_status() returns trigger
language plpgsql as $$
begin
  if new.status = 'Declined' and old.status is distinct from 'Declined' then
    new.archived := true;
  end if;
  return new;
end $$;

drop trigger if exists trg_outreach_before_status on public.outreach_creators;
create trigger trg_outreach_before_status before update on public.outreach_creators
  for each row execute function public.outreach_before_status();

create or replace function public.outreach_after_status() returns trigger
language plpgsql as $$
begin
  if new.status = 'Won' and old.status is distinct from 'Won' then
    insert into public.outreach_accepted(creator_id, handle, name, email)
    select new.id, new.handle, new.name, new.email
    where not exists (select 1 from public.outreach_accepted a where a.handle = new.handle);
  end if;
  if new.status = 'Declined' and old.status is distinct from 'Declined' then
    if coalesce(new.email,'') <> '' then
      insert into public.outreach_suppression(email, handle, reason)
      values (new.email, new.handle, 'declined') on conflict (email) do nothing;
    end if;
    insert into public.outreach_archive(id, handle, data, reason)
    values (new.id, new.handle, to_jsonb(new), 'declined') on conflict (id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists trg_outreach_after_status on public.outreach_creators;
create trigger trg_outreach_after_status after update on public.outreach_creators
  for each row execute function public.outreach_after_status();

create or replace function public.outreach_purge() returns integer
language plpgsql as $$
declare n integer;
begin
  delete from public.outreach_creators where archived = true and updated_at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from public.outreach_archive where archived_at < now() - interval '30 days';
  return n;
end $$;
