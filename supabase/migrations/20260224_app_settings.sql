create table if not exists app_settings (
  key text primary key,
  threshold_aqi integer not null default 450,
  threshold_uv numeric(4,1) not null default 7.0,
  threshold_bmp_temp numeric(5,1) not null default 28.0,
  threshold_pressure integer not null default 990,
  threshold_rain_percentage integer not null default 70,
  report_times jsonb not null default '["09:00","12:00","18:00"]'::jsonb,
  alert_rate text not null default 'immediate',
  timezone text not null default 'Asia/Kolkata',
  updated_at timestamptz not null default now()
);

insert into app_settings (key)
values ('global')
on conflict (key) do nothing;
