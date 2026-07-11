-- Peek — Supabase schema + Row Level Security
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- Design note: the FULL-RESOLUTION images are NEVER stored here. They live only
-- in each author's browser (IndexedDB) and stream peer-to-peer on demand.
-- The only image data in this DB is a tiny ~32px base64 JPEG "preview" (LQIP)
-- so a post still shows *something* when its author is offline.

-- ---------------------------------------------------------------------------
-- profiles: one row per user, id === auth.users.id
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  bio        text not null default '',
  avatar     text not null default '',            -- tiny base64 LQIP, optional
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: readable by all"
  on public.profiles for select using (true);
create policy "profiles: insert own"
  on public.profiles for insert with check (auth.uid() = id);
create policy "profiles: update own"
  on public.profiles for update using (auth.uid() = id);

-- Auto-create a profile whenever a new auth user signs up. The username is
-- read from the signup metadata (options.data.username); if missing we fall
-- back to a slug of the user id so the row is always valid.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'username',''),
             'user_' || substr(new.id::text, 1, 8))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- posts: metadata + LQIP preview only (no full image)
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  caption    text not null default '',
  preview    text not null,                        -- base64 data URL, ~32px JPEG
  w          int,                                  -- natural width  (for aspect ratio)
  h          int,                                  -- natural height
  created_at timestamptz not null default now()
);
create index if not exists posts_created_idx on public.posts (created_at desc);
create index if not exists posts_user_idx    on public.posts (user_id);

alter table public.posts enable row level security;

create policy "posts: readable by all"
  on public.posts for select using (true);
create policy "posts: insert own"
  on public.posts for insert with check (auth.uid() = user_id);
create policy "posts: delete own"
  on public.posts for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- likes: composite (post, user)
-- ---------------------------------------------------------------------------
create table if not exists public.likes (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.likes enable row level security;

create policy "likes: readable by all"
  on public.likes for select using (true);
create policy "likes: insert as self"
  on public.likes for insert with check (auth.uid() = user_id);
create policy "likes: delete own"
  on public.likes for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

alter table public.comments enable row level security;

create policy "comments: readable by all"
  on public.comments for select using (true);
create policy "comments: insert as self"
  on public.comments for insert with check (auth.uid() = user_id);
create policy "comments: delete own"
  on public.comments for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- follows: follower -> following
-- ---------------------------------------------------------------------------
create table if not exists public.follows (
  follower_id  uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

alter table public.follows enable row level security;

create policy "follows: readable by all"
  on public.follows for select using (true);
create policy "follows: insert as self"
  on public.follows for insert with check (auth.uid() = follower_id);
create policy "follows: delete own"
  on public.follows for delete using (auth.uid() = follower_id);

-- ---------------------------------------------------------------------------
-- Realtime: let clients subscribe to new posts / likes / comments live.
-- (Presence + P2P signaling ride Realtime channels and PeerJS, no table needed.)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.posts;
alter publication supabase_realtime add table public.likes;
alter publication supabase_realtime add table public.comments;

-- ---------------------------------------------------------------------------
-- Backfill: create a profile for anyone who signed up before this ran.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, username)
select u.id,
       coalesce(nullif(u.raw_user_meta_data->>'username',''),
                'user_' || substr(u.id::text, 1, 8))
from auth.users u
on conflict (id) do nothing;

-- ===========================================================================
-- v2: notifications, private accounts, follow requests, multi-image posts
-- (Adds columns / a table and REPLACES a few policies from above.)
-- ===========================================================================

-- private accounts, follow-request status, multi-image previews
alter table public.profiles add column if not exists is_private boolean not null default false;
alter table public.follows  add column if not exists status text not null default 'accepted';
alter table public.posts    add column if not exists previews text[];   -- LQIP data URLs (cover first)

-- notifications
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id     uuid not null references public.profiles(id) on delete cascade,
  type         text not null,                        -- follow | follow_request | follow_accept | like | comment
  post_id      uuid references public.posts(id) on delete cascade,
  read         boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists "notif_select" on public.notifications;
create policy "notif_select" on public.notifications for select using (auth.uid() = recipient_id);
drop policy if exists "notif_insert" on public.notifications;
create policy "notif_insert" on public.notifications for insert with check (auth.uid() = actor_id);
drop policy if exists "notif_update" on public.notifications;
create policy "notif_update" on public.notifications for update using (auth.uid() = recipient_id);
drop policy if exists "notif_delete" on public.notifications;
create policy "notif_delete" on public.notifications for delete using (auth.uid() = recipient_id or auth.uid() = actor_id);
alter publication supabase_realtime add table public.notifications;

-- follows: private-aware insert / update (approve) / delete (unfollow or remove)
drop policy if exists "follows: insert as self" on public.follows;
create policy "follows_insert" on public.follows for insert with check (
  auth.uid() = follower_id and (
    (status = 'accepted' and exists (select 1 from public.profiles p where p.id = following_id and p.is_private = false))
    or (status = 'pending' and exists (select 1 from public.profiles p where p.id = following_id and p.is_private = true))
  )
);
drop policy if exists "follows: delete own" on public.follows;
create policy "follows_delete" on public.follows for delete using (auth.uid() = follower_id or auth.uid() = following_id);
drop policy if exists "follows_update" on public.follows;
create policy "follows_update" on public.follows for update using (auth.uid() = following_id);

-- posts: readable if the author is public, it's yours, or you're an accepted follower
drop policy if exists "posts: readable by all" on public.posts;
drop policy if exists "posts_select" on public.posts;
create policy "posts_select" on public.posts for select using (
  auth.uid() = user_id
  or exists (select 1 from public.profiles p where p.id = posts.user_id and p.is_private = false)
  or exists (select 1 from public.follows f where f.following_id = posts.user_id and f.follower_id = auth.uid() and f.status = 'accepted')
);

-- ===========================================================================
-- v3: group chats (persistent) + mesh video calls
-- ===========================================================================
create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);

-- security definer avoids RLS recursion on group_members
create or replace function public.is_group_member(gid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = gid and user_id = uid);
$$;

alter table public.groups enable row level security;
alter table public.group_members enable row level security;

-- creator can read their group even before the member row exists (so insert…select works)
drop policy if exists "groups_select" on public.groups;
create policy "groups_select" on public.groups for select using (public.is_group_member(id, auth.uid()) or auth.uid() = created_by);
drop policy if exists "groups_insert" on public.groups;
create policy "groups_insert" on public.groups for insert with check (auth.uid() = created_by);
drop policy if exists "groups_update" on public.groups;
create policy "groups_update" on public.groups for update using (auth.uid() = created_by);
drop policy if exists "groups_delete" on public.groups;
create policy "groups_delete" on public.groups for delete using (auth.uid() = created_by);

drop policy if exists "gm_select" on public.group_members;
create policy "gm_select" on public.group_members for select using (public.is_group_member(group_id, auth.uid()));
drop policy if exists "gm_insert" on public.group_members;
create policy "gm_insert" on public.group_members for insert with check (
  public.is_group_member(group_id, auth.uid())
  or auth.uid() = (select created_by from public.groups g where g.id = group_id)
);
drop policy if exists "gm_delete" on public.group_members;
create policy "gm_delete" on public.group_members for delete using (
  user_id = auth.uid() or auth.uid() = (select created_by from public.groups g where g.id = group_id)
);

-- ===========================================================================
-- v4: security hardening (from the code review)
-- ===========================================================================

-- Realtime Authorization: private "group:<uuid>" channels are member-only.
-- (Public channels don't consult realtime.messages, so presence/signal/feed are unaffected.)
drop policy if exists "group_read"  on realtime.messages;
create policy "group_read" on realtime.messages for select to authenticated using (
  realtime.topic() like 'group:%'
  and public.is_group_member((substring(realtime.topic() from 7))::uuid, auth.uid())
);
drop policy if exists "group_write" on realtime.messages;
create policy "group_write" on realtime.messages for insert to authenticated with check (
  realtime.topic() like 'group:%'
  and public.is_group_member((substring(realtime.topic() from 7))::uuid, auth.uid())
);

-- Notifications: only allow known types (mild anti-spam).
drop policy if exists "notif_insert" on public.notifications;
create policy "notif_insert" on public.notifications for insert with check (
  auth.uid() = actor_id and type in ('follow','follow_request','follow_accept','like','comment')
);
