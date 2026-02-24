// =====================================================
// Supabase Client (Aligned with provided schema)
// Tables:
// - sensor_data
// - notifications
// - alert_thresholds
// - app_settings
// - telegram_subscribers
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const webPush = require('web-push');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

const DEFAULT_USER_ID = 'global-user';
const APP_SETTINGS_KEY = 'global';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_ALERT_RATE = 'immediate';
const DEFAULT_REPORT_TIMES = ['09:00', '12:00', '18:00'];
const ALLOWED_ALERT_RATES = new Set(['immediate', '15min', '30min', 'hourly']);
const TIME_REGEX = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
const DEFAULT_VAPID_SUBJECT = 'mailto:admin@campussense.local';

const DEFAULT_THRESHOLD_ROWS = [
  { metric: 'aqi', threshold_value: 450, alert_if_above: true, description: 'Air quality threshold' },
  { metric: 'uv', threshold_value: 7.0, alert_if_above: true, description: 'UV threshold' },
  { metric: 'bmp_temp', threshold_value: 28.0, alert_if_above: true, description: 'Temperature threshold' },
  { metric: 'pressure', threshold_value: 990, alert_if_above: false, description: 'Pressure threshold' },
  { metric: 'rain_percentage', threshold_value: 70, alert_if_above: true, description: 'Rain threshold' }
];

const METRIC_COLUMN_MAP = {
  bmp_temp: 'bmp_temp',
  dht_temp: 'dht_temp',
  aqi: 'co2_ppm',
  uv: 'uv_index',
  humidity: 'humidity',
  pressure: 'pressure',
  light_level: 'light_pcnt',
  rain_percentage: 'rain_pcnt'
};

function makeHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isMissingTableError(err, tableName) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('could not find the table') && msg.includes(String(tableName).toLowerCase());
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTimes(times) {
  if (!Array.isArray(times)) return [];
  const unique = [];
  for (const t of times) {
    const raw = String(t || '').trim();
    const val = raw.length >= 5 ? raw.slice(0, 5) : raw;
    if (!TIME_REGEX.test(val)) continue;
    if (!unique.includes(val)) unique.push(val);
  }
  return unique;
}

function hhmmToMinutes(time) {
  const [h, m] = String(time || '00:00').slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function isWithinWindow(nowHHMM, startHHMM, endHHMM) {
  const now = hhmmToMinutes(nowHHMM);
  const start = hhmmToMinutes(startHHMM);
  const end = hhmmToMinutes(endHHMM);
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

function getCurrentHHMM(timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone || DEFAULT_TIMEZONE
  });
  return fmt.format(new Date());
}

function getCooldownMs(alertRate) {
  switch (alertRate) {
    case 'immediate':
      return 60 * 1000;
    case '15min':
      return 15 * 60 * 1000;
    case '30min':
      return 30 * 60 * 1000;
    case 'hourly':
      return 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

function resolveRangeWindow(rangeInput) {
  const now = new Date();
  const range = String(rangeInput || '24h').trim();
  let start = new Date(now);
  let limit = 300;

  if (range === '5m') {
    start = new Date(now.getTime() - 5 * 60 * 1000);
    limit = 120;
  } else if (range === '1h') {
    start = new Date(now.getTime() - 60 * 60 * 1000);
    limit = 240;
  } else if (range === '24h' || range === 'today') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    limit = 720;
  } else if (range === '7d') {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    limit = 1200;
  } else {
    throw makeHttpError(400, `Invalid range: ${range}`);
  }

  return { startIso: start.toISOString(), endIso: now.toISOString(), limit };
}

function normalizeSensorData(row) {
  if (!row) return null;
  return {
    ...row,
    aqi: row.aqi ?? row.co2_ppm ?? null,
    uv: row.uv ?? row.uv_index ?? null,
    rain_percentage: row.rain_percentage ?? row.rain_pcnt ?? null,
    light_level: row.light_level ?? row.light_pcnt ?? null
  };
}

function parseReportTimes(raw) {
  if (Array.isArray(raw)) return normalizeTimes(raw);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return normalizeTimes(parsed);
    } catch {
      return normalizeTimes([raw]);
    }
  }
  return [];
}

// =====================================================
// app_settings (single-row key='global')
// =====================================================

async function getOrCreateAppSettingsRow() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('key', APP_SETTINGS_KEY)
    .maybeSingle();

  if (error) {
    console.error('[app_settings] fetch failed:', error.message);
    throw error;
  }
  if (data) return data;

  const insertPayload = {
    key: APP_SETTINGS_KEY,
    threshold_aqi: 450,
    threshold_uv: 7.0,
    threshold_bmp_temp: 28.0,
    threshold_pressure: 990,
    threshold_rain_percentage: 70,
    report_times: DEFAULT_REPORT_TIMES,
    alert_rate: DEFAULT_ALERT_RATE,
    timezone: DEFAULT_TIMEZONE,
    updated_at: new Date().toISOString()
  };

  const { data: inserted, error: insertError } = await supabase
    .from('app_settings')
    .insert([insertPayload])
    .select('*')
    .maybeSingle();

  if (insertError) {
    console.error('[app_settings] create default failed:', insertError.message);
    throw insertError;
  }

  return inserted || insertPayload;
}

function getVapidConfigFromSettings(row) {
  const publicKey = String(row?.vapid_public_key || process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(row?.vapid_private_key || process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(row?.vapid_subject || process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT).trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

function configureWebPush(vapidConfig) {
  try {
    webPush.setVapidDetails(vapidConfig.subject, vapidConfig.publicKey, vapidConfig.privateKey);
    return true;
  } catch (err) {
    console.error('[web-push] VAPID configure failed:', err.message);
    return false;
  }
}

async function getVapidPublicKey() {
  const row = await getOrCreateAppSettingsRow();
  const key = String(row?.vapid_public_key || process.env.VAPID_PUBLIC_KEY || '').trim();
  if (!key) throw makeHttpError(503, 'VAPID public key is not configured');
  return key;
}

async function savePushSubscription({ userId, subscription }) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw makeHttpError(400, 'Invalid push subscription payload');
  }

  const endpoint = String(subscription.endpoint).trim();
  const p256dh = String(subscription.keys.p256dh || '').trim();
  const auth = String(subscription.keys.auth || '').trim();
  if (!endpoint || !p256dh || !auth) {
    throw makeHttpError(400, 'Push subscription endpoint/keys are required');
  }

  const payload = {
    user_id: String(userId || DEFAULT_USER_ID).trim() || DEFAULT_USER_ID,
    endpoint,
    p256dh,
    auth,
    is_active: true,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert([payload], { onConflict: 'endpoint' });

  if (error) {
    if (isMissingTableError(error, 'push_subscriptions')) {
      throw makeHttpError(503, 'push_subscriptions table is missing');
    }
    throw error;
  }
  return true;
}

async function deactivatePushSubscription(endpoint) {
  const cleanEndpoint = String(endpoint || '').trim();
  if (!cleanEndpoint) return false;
  const { error } = await supabase
    .from('push_subscriptions')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('endpoint', cleanEndpoint);

  if (error && !isMissingTableError(error, 'push_subscriptions')) {
    console.warn('[web-push] deactivate subscription failed:', error.message);
  }
  return true;
}

async function getActivePushSubscriptions() {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, is_active')
    .eq('is_active', true);

  if (error) {
    if (isMissingTableError(error, 'push_subscriptions')) return [];
    console.warn('[web-push] fetch active subscriptions failed:', error.message);
    return [];
  }

  return (data || []).filter((s) => s.endpoint && s.p256dh && s.auth);
}

async function sendWebPushNotification({ title, message, type = 'info', url = '/' }) {
  const settings = await getOrCreateAppSettingsRow();
  const vapidConfig = getVapidConfigFromSettings(settings);
  if (!vapidConfig) {
    console.warn('[web-push] VAPID keys missing; skipping push send');
    return { sent: 0, failed: 0 };
  }

  if (!configureWebPush(vapidConfig)) return { sent: 0, failed: 0 };

  const subscriptions = await getActivePushSubscriptions();
  if (subscriptions.length === 0) return { sent: 0, failed: 0 };

  const payload = JSON.stringify({
    title,
    body: message,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    type,
    url
  });

  let sent = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        },
        payload
      );
      sent += 1;
      await supabase
        .from('push_subscriptions')
        .update({ last_success_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', sub.id);
    } catch (err) {
      failed += 1;
      console.warn('[web-push] send failed:', err.statusCode || '', err.message);

      const status = Number(err?.statusCode);
      if (status === 404 || status === 410) {
        await deactivatePushSubscription(sub.endpoint);
      } else {
        await supabase
          .from('push_subscriptions')
          .update({ last_error: String(err.message || 'send failed').slice(0, 500), updated_at: new Date().toISOString() })
          .eq('id', sub.id);
      }
    }
  }

  return { sent, failed };
}

// =====================================================
// alert_thresholds
// =====================================================

async function ensureDefaultThresholds() {
  const { data, error } = await supabase
    .from('alert_thresholds')
    .select('metric');

  if (error) {
    if (isMissingTableError(error, 'alert_thresholds')) {
      console.warn('[thresholds] table missing; using app_settings fallback');
      return;
    }
    console.error('[thresholds] fetch failed:', error.message);
    throw error;
  }

  const existing = new Set((data || []).map((d) => d.metric));
  const missing = DEFAULT_THRESHOLD_ROWS.filter((row) => !existing.has(row.metric));
  if (missing.length === 0) return;

  const { error: insertError } = await supabase
    .from('alert_thresholds')
    .upsert(
      missing.map((row) => ({ ...row, updated_at: new Date().toISOString() })),
      { onConflict: 'metric' }
    );

  if (insertError) {
    console.error('[thresholds] seed defaults failed:', insertError.message);
    throw insertError;
  }
}

async function getThresholdRows() {
  await ensureDefaultThresholds();
  const { data, error } = await supabase
    .from('alert_thresholds')
    .select('metric, threshold_value, alert_if_above, updated_at');

  if (error) {
    if (isMissingTableError(error, 'alert_thresholds')) {
      const app = await getOrCreateAppSettingsRow();
      return [
        { metric: 'aqi', threshold_value: app.threshold_aqi, alert_if_above: true, updated_at: app.updated_at },
        { metric: 'uv', threshold_value: app.threshold_uv, alert_if_above: true, updated_at: app.updated_at },
        { metric: 'bmp_temp', threshold_value: app.threshold_bmp_temp, alert_if_above: true, updated_at: app.updated_at },
        { metric: 'pressure', threshold_value: app.threshold_pressure, alert_if_above: false, updated_at: app.updated_at },
        { metric: 'rain_percentage', threshold_value: app.threshold_rain_percentage, alert_if_above: true, updated_at: app.updated_at }
      ];
    }
    console.error('[thresholds] get rows failed:', error.message);
    throw error;
  }

  return data || [];
}

function thresholdRowsToUiShape(rows) {
  const byMetric = {};
  for (const row of rows) byMetric[row.metric] = row;

  return {
    aqi: safeNumber(byMetric.aqi?.threshold_value, 450),
    uv: safeNumber(byMetric.uv?.threshold_value, 7),
    bmp_temp: safeNumber(byMetric.bmp_temp?.threshold_value, 28),
    pressure: safeNumber(byMetric.pressure?.threshold_value, 990),
    rain_percentage: safeNumber(byMetric.rain_percentage?.threshold_value, 70)
  };
}

// =====================================================
// sensor_data
// =====================================================

async function insertSensorData(data) {
  try {
    const { error } = await supabase.from('sensor_data').insert([data]);
    if (error) {
      console.error('[sensor] insert failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[sensor] insert exception:', err.message);
    return false;
  }
}

async function getLatestSensorData() {
  try {
    const { data, error } = await supabase
      .from('sensor_data')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[sensor] latest fetch failed:', error.message);
      return null;
    }
    return normalizeSensorData(data);
  } catch (err) {
    console.error('[sensor] latest fetch exception:', err.message);
    return null;
  }
}

async function getGraphData({ metric, range }) {
  const requestedMetric = String(metric || 'bmp_temp').trim();
  const column = METRIC_COLUMN_MAP[requestedMetric];
  if (!column) throw makeHttpError(400, `Unsupported metric: ${requestedMetric}`);

  const { startIso, endIso, limit } = resolveRangeWindow(range);
  const { data, error } = await supabase
    .from('sensor_data')
    .select(`created_at, ${column}`)
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[graph] query failed:', error.message);
    throw error;
  }

  return (data || [])
    .map((row) => ({ created_at: row.created_at, value: safeNumber(row[column]) }))
    .filter((row) => row.created_at && Number.isFinite(row.value));
}

// =====================================================
// notifications
// =====================================================

async function insertWebNotification(title, message, type = 'info') {
  try {
    const { error } = await supabase
      .from('notifications')
      .insert([{ title, message, type, is_read: false }]);

    if (error) {
      console.error('[notifications] insert failed:', error.message);
      return false;
    }
    await sendWebPushNotification({
      title: title || 'CampusSense Alert',
      message: message || 'New update available',
      type
    });
    return true;
  } catch (err) {
    console.error('[notifications] insert exception:', err.message);
    return false;
  }
}

async function getWebNotifications(limit = 20) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      console.error('[notifications] fetch failed:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[notifications] fetch exception:', err.message);
    return [];
  }
}

async function markNotificationRead(id) {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id);
    return !error;
  } catch {
    return false;
  }
}

// =====================================================
// Threshold + settings APIs
// =====================================================

async function getThresholdSettings() {
  const rows = await getThresholdRows();
  return thresholdRowsToUiShape(rows);
}

async function setThresholdSettings(payload) {
  const aqi = safeNumber(payload?.aqi);
  const uv = safeNumber(payload?.uv);
  const bmpTemp = safeNumber(payload?.bmp_temp);
  const pressure = safeNumber(payload?.pressure);
  const rainPercentage = safeNumber(payload?.rain_percentage);

  if (
    !Number.isFinite(aqi) ||
    !Number.isFinite(uv) ||
    !Number.isFinite(bmpTemp) ||
    !Number.isFinite(pressure) ||
    !Number.isFinite(rainPercentage)
  ) {
    throw makeHttpError(400, 'Invalid threshold payload');
  }

  const rows = [
    { metric: 'aqi', threshold_value: Math.round(aqi), alert_if_above: true, description: 'Air quality threshold' },
    { metric: 'uv', threshold_value: uv, alert_if_above: true, description: 'UV threshold' },
    { metric: 'bmp_temp', threshold_value: bmpTemp, alert_if_above: true, description: 'Temperature threshold' },
    { metric: 'pressure', threshold_value: Math.round(pressure), alert_if_above: false, description: 'Pressure threshold' },
    { metric: 'rain_percentage', threshold_value: Math.round(rainPercentage), alert_if_above: true, description: 'Rain threshold' }
  ];

  const { error } = await supabase
    .from('alert_thresholds')
    .upsert(rows.map((row) => ({ ...row, updated_at: new Date().toISOString() })), { onConflict: 'metric' });

  if (error && !isMissingTableError(error, 'alert_thresholds')) {
    console.error('[thresholds] save failed:', error.message);
    throw error;
  }

  // keep app_settings threshold columns in sync for compatibility
  const app = await getOrCreateAppSettingsRow();
  const { error: appErr } = await supabase
    .from('app_settings')
    .update({
      threshold_aqi: Math.round(aqi),
      threshold_uv: uv,
      threshold_bmp_temp: bmpTemp,
      threshold_pressure: Math.round(pressure),
      threshold_rain_percentage: Math.round(rainPercentage),
      updated_at: new Date().toISOString()
    })
    .eq('key', app.key || APP_SETTINGS_KEY);

  if (appErr) {
    console.warn('[app_settings] threshold sync failed:', appErr.message);
  }

  return getThresholdSettings();
}

async function getNotificationSettings() {
  const row = await getOrCreateAppSettingsRow();
  const times = parseReportTimes(row.report_times);
  const alertRate = ALLOWED_ALERT_RATES.has(row.alert_rate) ? row.alert_rate : DEFAULT_ALERT_RATE;
  return {
    report_times: times.length ? times : [...DEFAULT_REPORT_TIMES],
    alert_rate: alertRate,
    rate: alertRate,
    timezone: row.timezone || DEFAULT_TIMEZONE
  };
}

async function setNotificationSettings(payload) {
  const reportTimes = normalizeTimes(payload?.report_times);
  if (reportTimes.length === 0) {
    throw makeHttpError(400, 'report_times must contain at least one valid HH:MM value');
  }

  const requestedRate = String(payload?.alert_rate ?? payload?.rate ?? '').trim();
  const alertRate = requestedRate || DEFAULT_ALERT_RATE;
  if (!ALLOWED_ALERT_RATES.has(alertRate)) {
    throw makeHttpError(400, 'Invalid alert_rate');
  }

  const timezone = String(payload?.timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  const row = await getOrCreateAppSettingsRow();

  const { error } = await supabase
    .from('app_settings')
    .update({
      report_times: reportTimes,
      alert_rate: alertRate,
      timezone,
      updated_at: new Date().toISOString()
    })
    .eq('key', row.key || APP_SETTINGS_KEY);

  if (error) {
    console.error('[app_settings] save report settings failed:', error.message);
    throw error;
  }

  return getNotificationSettings();
}

// =====================================================
// Alert trigger engine
// =====================================================

async function wasAlertRecentlySent(cooldownMs) {
  const sinceIso = new Date(Date.now() - cooldownMs).toISOString();
  const { data, error } = await supabase
    .from('notifications')
    .select('id')
    .eq('type', 'alert')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.warn('[alerts] cooldown check failed; allowing send:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function processThresholdAlerts({ sensorData }) {
  const thresholds = await getThresholdRows();
  const prefs = await getNotificationSettings();
  const times = [...prefs.report_times].sort();
  const start = times[0] || '00:00';
  const end = times[times.length - 1] || '23:59';
  const nowHHMM = getCurrentHHMM(prefs.timezone);

  if (!isWithinWindow(nowHHMM, start, end)) {
    return { triggered: false, reason: 'outside-preferred-time-window' };
  }

  const cooldownMs = getCooldownMs(prefs.alert_rate);
  if (await wasAlertRecentlySent(cooldownMs)) {
    return { triggered: false, reason: 'cooldown-active' };
  }

  const normalized = normalizeSensorData(sensorData);
  const fired = [];
  for (const row of thresholds) {
    const threshold = safeNumber(row.threshold_value);
    if (!Number.isFinite(threshold)) continue;

    let value = null;
    if (row.metric === 'aqi') value = safeNumber(normalized?.aqi);
    else if (row.metric === 'uv') value = safeNumber(normalized?.uv);
    else if (row.metric === 'bmp_temp') value = safeNumber(normalized?.bmp_temp);
    else if (row.metric === 'pressure') value = safeNumber(normalized?.pressure);
    else if (row.metric === 'rain_percentage') value = safeNumber(normalized?.rain_percentage);
    if (!Number.isFinite(value)) continue;

    const crosses = row.alert_if_above ? value >= threshold : value <= threshold;
    if (crosses) fired.push({ metric: row.metric, value, threshold, alert_if_above: !!row.alert_if_above });
  }

  if (fired.length === 0) return { triggered: false, reason: 'no-threshold-crossing' };

  const parts = fired.map((a) => `${a.metric}: ${a.value.toFixed(1)} (${a.alert_if_above ? '>=' : '<='} ${a.threshold})`);
  const message = `Threshold crossed - ${parts.join(', ')}`;
  await insertWebNotification('Threshold Alert', message, 'alert');

  return { triggered: true, reason: 'threshold-crossed', message, alerts: fired };
}

// =====================================================
// Telegram subscribers (broadcast)
// =====================================================

async function upsertTelegramSubscriber({ chatId, firstName, username, isSubscribed = true }) {
  const numericChatId = Number(chatId);
  if (!Number.isFinite(numericChatId)) return false;

  const payload = {
    chat_id: numericChatId,
    first_name: firstName || null,
    username: username || null,
    is_subscribed: !!isSubscribed,
    subscribed_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('telegram_subscribers')
    .upsert([payload], { onConflict: 'chat_id' });

  if (error) {
    if (isMissingTableError(error, 'telegram_subscribers')) {
      console.warn('[telegram_subscribers] table missing');
      return false;
    }
    console.error('[telegram_subscribers] upsert failed:', error.message);
    return false;
  }
  return true;
}

async function setTelegramSubscription(chatId, isSubscribed) {
  const numericChatId = Number(chatId);
  if (!Number.isFinite(numericChatId)) return false;

  const { error } = await supabase
    .from('telegram_subscribers')
    .update({ is_subscribed: !!isSubscribed })
    .eq('chat_id', numericChatId);

  if (error) {
    if (isMissingTableError(error, 'telegram_subscribers')) return false;
    console.error('[telegram_subscribers] update failed:', error.message);
    return false;
  }
  return true;
}

async function getActiveTelegramSubscribers() {
  const { data, error } = await supabase
    .from('telegram_subscribers')
    .select('chat_id')
    .eq('is_subscribed', true);

  if (error) {
    if (isMissingTableError(error, 'telegram_subscribers')) return [];
    console.error('[telegram_subscribers] fetch failed:', error.message);
    return [];
  }

  return (data || [])
    .map((row) => Number(row.chat_id))
    .filter((id) => Number.isFinite(id));
}

// =====================================================
// Sharing
// =====================================================

function buildShareLinks(userIdInput, requestOrigin) {
  const userId = String(userIdInput || DEFAULT_USER_ID).trim() || DEFAULT_USER_ID;
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'your_bot_username').trim();
  const origin = String(process.env.RENDER_EXTERNAL_URL || requestOrigin || '')
    .trim()
    .replace(/\/$/, '');
  const dashboardBase = origin || 'http://localhost:10000';

  return {
    user_id: userId,
    bot_username: botUsername,
    dashboard_link: `${dashboardBase}/?user_id=${encodeURIComponent(userId)}`,
    telegram_deep_link: `https://t.me/${botUsername}?start=${encodeURIComponent(userId)}`
  };
}

module.exports = {
  supabase,
  DEFAULT_USER_ID,
  insertSensorData,
  getLatestSensorData,
  getGraphData,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead,
  getThresholdSettings,
  setThresholdSettings,
  getNotificationSettings,
  setNotificationSettings,
  processThresholdAlerts,
  getVapidPublicKey,
  savePushSubscription,
  deactivatePushSubscription,
  sendWebPushNotification,
  upsertTelegramSubscriber,
  setTelegramSubscription,
  getActiveTelegramSubscribers,
  buildShareLinks
};
