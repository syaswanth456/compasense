create table if not exists sensor_logs (
  id bigserial primary key,
  user_id text not null default 'global-user',
  temperature double precision,
  humidity double precision,
  pressure double precision,
  created_at timestamptz not null default now()
);

create index if not exists idx_sensor_logs_user_created_at
  on sensor_logs (user_id, created_at desc);

create table if not exists user_settings (
  user_id text primary key,
  temp_threshold numeric(5,2) not null default 28.0,
  humidity_threshold numeric(5,2) not null default 80.0,
  pressure_threshold numeric(7,2) not null default 990.0,
  notification_enabled boolean not null default true,
  notify_start_time time not null default '00:00',
  notify_end_time time not null default '23:59',
  alert_cooldown_minutes integer not null default 15,
  last_alert_sent timestamptz,
  updated_at timestamptz not null default now()
);

insert into user_settings (user_id)
values ('global-user')
on conflict (user_id) do nothing;

create table if not exists alert_logs (
  id bigserial primary key,
  user_id text not null,
  alert_type text not null,
  value double precision not null,
  threshold double precision not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_alert_logs_user_created_at
  on alert_logs (user_id, created_at desc);

alter table notifications
  add column if not exists user_id text;
