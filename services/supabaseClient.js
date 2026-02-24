// =====================================================
// Supabase Client + Data/Alert Services
// =====================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

const APP_SETTINGS_KEY = 'global';
const DEFAULT_USER_ID = 'global-user';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const DEFAULT_APP_SETTINGS = {
  threshold_aqi: 450,
  threshold_uv: 7.0,
  threshold_bmp_temp: 28.0,
  threshold_pressure: 990,
  threshold_rain_percentage: 70,
  report_times: ['09:00', '12:00', '18:00'],
  alert_rate: 'immediate',
  timezone: DEFAULT_TIMEZONE
};

const DEFAULT_USER_SETTINGS = {
  temp_threshold: 28.0,
  humidity_threshold: 80,
  pressure_threshold: 990,
  notification_enabled: true,
  notify_start_time: '00:00',
  notify_end_time: '23:59',
  alert_cooldown_minutes: 15,
  last_alert_sent: null
};

const TIME_REGEX = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
const ALLOWED_ALERT_RATES = new Set(['immediate', '15min', '30min', 'hourly']);

const GRAPH_METRIC_MAP = {
  bmp_temp: { table: 'sensor_data', column: 'bmp_temp' },
  dht_temp: { table: 'sensor_data', column: 'dht_temp' },
  aqi: { table: 'sensor_data', column: 'co2_ppm' },
  uv: { table: 'sensor_data', column: 'uv_index' },
  humidity: { table: 'sensor_logs', column: 'humidity', fallbackTable: 'sensor_data', fallbackColumn: 'humidity' },
  pressure: { table: 'sensor_logs', column: 'pressure', fallbackTable: 'sensor_data', fallbackColumn: 'pressure' },
  light_level: { table: 'sensor_data', column: 'light_pcnt' },
  rain_percentage: { table: 'sensor_data', column: 'rain_pcnt' },
  temperature: { table: 'sensor_logs', column: 'temperature', fallbackTable: 'sensor_data', fallbackColumn: 'bmp_temp' }
};

function makeHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isMissingRelationError(err, relationName) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('does not exist') && msg.includes(String(relationName).toLowerCase());
}

function resolveUserId(userId) {
  const cleaned = String(userId || '').trim();
  return cleaned || DEFAULT_USER_ID;
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTimes(times) {
  if (!Array.isArray(times)) return [];
  const unique = [];
  for (const value of times) {
    const raw = String(value || '').trim();
    const time = raw.length >= 5 ? raw.slice(0, 5) : raw;
    if (!TIME_REGEX.test(time)) continue;
    if (!unique.includes(time)) unique.push(time);
  }
  return unique;
}

function normalizeTimeValue(value, fallback) {
  const raw = String(value || '').trim();
  const time = raw.length >= 5 ? raw.slice(0, 5) : raw;
  return TIME_REGEX.test(time) ? time : fallback;
}

function hhmmToMinutes(time) {
  const normalized = normalizeTimeValue(time, '00:00');
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

function isWithinTimeWindow(currentTime, startTime, endTime) {
  const now = hhmmToMinutes(currentTime);
  const start = hhmmToMinutes(startTime);
  const end = hhmmToMinutes(endTime);
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

function getCurrentTimeInTimezone(timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone || DEFAULT_TIMEZONE
  });
  return fmt.format(new Date());
}

function getRateCooldownMinutes(alertRate) {
  switch (alertRate) {
    case 'immediate':
      return 1;
    case '15min':
      return 15;
    case '30min':
      return 30;
    case 'hourly':
      return 60;
    default:
      return 15;
  }
}

function getRateCooldownMs(alertRate, explicitMinutes) {
  const mins = Number.isFinite(Number(explicitMinutes))
    ? Math.max(1, Number(explicitMinutes))
    : getRateCooldownMinutes(alertRate);
  return mins * 60 * 1000;
}

function deriveWindowFromReportTimes(reportTimes) {
  const sorted = [...normalizeTimes(reportTimes)].sort();
  if (sorted.length === 0) {
    return { notify_start_time: DEFAULT_USER_SETTINGS.notify_start_time, notify_end_time: DEFAULT_USER_SETTINGS.notify_end_time };
  }
  return {
    notify_start_time: sorted[0],
    notify_end_time: sorted[sorted.length - 1]
  };
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

  return { range, startIso: start.toISOString(), endIso: now.toISOString(), limit };
}

function normalizeAppSettingsRow(row) {
  const reportTimes = normalizeTimes(row?.report_times);
  return {
    key: APP_SETTINGS_KEY,
    threshold_aqi: safeNumber(row?.threshold_aqi, DEFAULT_APP_SETTINGS.threshold_aqi),
    threshold_uv: safeNumber(row?.threshold_uv, DEFAULT_APP_SETTINGS.threshold_uv),
    threshold_bmp_temp: safeNumber(row?.threshold_bmp_temp, DEFAULT_APP_SETTINGS.threshold_bmp_temp),
    threshold_pressure: safeNumber(row?.threshold_pressure, DEFAULT_APP_SETTINGS.threshold_pressure),
    threshold_rain_percentage: safeNumber(
      row?.threshold_rain_percentage,
      DEFAULT_APP_SETTINGS.threshold_rain_percentage
    ),
    report_times: reportTimes.length > 0 ? reportTimes : [...DEFAULT_APP_SETTINGS.report_times],
    alert_rate: row?.alert_rate || DEFAULT_APP_SETTINGS.alert_rate,
    timezone: row?.timezone || DEFAULT_APP_SETTINGS.timezone
  };
}

function normalizeUserSettingsRow(row, appSettings, userId) {
  const fallbackStartEnd = deriveWindowFromReportTimes(appSettings.report_times);
  return {
    user_id: userId,
    temp_threshold: safeNumber(row?.temp_threshold, appSettings.threshold_bmp_temp),
    humidity_threshold: safeNumber(row?.humidity_threshold, DEFAULT_USER_SETTINGS.humidity_threshold),
    pressure_threshold: safeNumber(row?.pressure_threshold, appSettings.threshold_pressure),
    notification_enabled: row?.notification_enabled !== false,
    notify_start_time: normalizeTimeValue(row?.notify_start_time, fallbackStartEnd.notify_start_time),
    notify_end_time: normalizeTimeValue(row?.notify_end_time, fallbackStartEnd.notify_end_time),
    alert_cooldown_minutes: safeNumber(
      row?.alert_cooldown_minutes,
      getRateCooldownMinutes(appSettings.alert_rate)
    ),
    last_alert_sent: row?.last_alert_sent || null
  };
}

// =====================================================
// SETTINGS
// =====================================================

async function getAppSettings() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .eq('key', APP_SETTINGS_KEY)
      .maybeSingle();

    if (error) throw error;
    if (data) return normalizeAppSettingsRow(data);

    const insertPayload = {
      key: APP_SETTINGS_KEY,
      ...DEFAULT_APP_SETTINGS
    };

    const { data: inserted, error: insertError } = await supabase
      .from('app_settings')
      .insert([insertPayload])
      .select('*')
      .maybeSingle();

    if (insertError) throw insertError;
    return normalizeAppSettingsRow(inserted || insertPayload);
  } catch (err) {
    console.error('[settings] failed to get app settings:', err.message);
    throw err;
  }
}

async function getUserSettings(userIdInput, options = {}) {
  const userId = resolveUserId(userIdInput);
  const appSettings = options.appSettings || await getAppSettings();
  const createIfMissing = options.createIfMissing !== false;

  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      if (isMissingRelationError(error, 'user_settings')) {
        console.warn('[settings] user_settings table missing; using fallback defaults');
        return normalizeUserSettingsRow(null, appSettings, userId);
      }
      throw error;
    }

    if (data) return normalizeUserSettingsRow(data, appSettings, userId);
    if (!createIfMissing) return normalizeUserSettingsRow(null, appSettings, userId);

    const startEnd = deriveWindowFromReportTimes(appSettings.report_times);
    const insertPayload = {
      user_id: userId,
      temp_threshold: appSettings.threshold_bmp_temp,
      humidity_threshold: DEFAULT_USER_SETTINGS.humidity_threshold,
      pressure_threshold: appSettings.threshold_pressure,
      notification_enabled: DEFAULT_USER_SETTINGS.notification_enabled,
      notify_start_time: startEnd.notify_start_time,
      notify_end_time: startEnd.notify_end_time,
      alert_cooldown_minutes: getRateCooldownMinutes(appSettings.alert_rate),
      updated_at: new Date().toISOString()
    };

    const { data: inserted, error: insertError } = await supabase
      .from('user_settings')
      .insert([insertPayload])
      .select('*')
      .maybeSingle();

    if (insertError) {
      if (isMissingRelationError(insertError, 'user_settings')) {
        console.warn('[settings] user_settings table missing during insert; using fallback defaults');
        return normalizeUserSettingsRow(insertPayload, appSettings, userId);
      }
      throw insertError;
    }

    return normalizeUserSettingsRow(inserted || insertPayload, appSettings, userId);
  } catch (err) {
    console.error('[settings] failed to get user settings:', err.message);
    throw err;
  }
}

async function upsertUserSettings(userIdInput, partialSettings = {}) {
  const userId = resolveUserId(userIdInput);
  const payload = {
    user_id: userId,
    ...partialSettings,
    updated_at: new Date().toISOString()
  };

  try {
    const { error } = await supabase
      .from('user_settings')
      .upsert([payload], { onConflict: 'user_id' });

    if (error) {
      if (isMissingRelationError(error, 'user_settings')) {
        console.warn('[settings] user_settings table missing; cannot persist user-level settings');
        return false;
      }
      throw error;
    }
    return true;
  } catch (err) {
    console.error('[settings] failed to upsert user settings:', err.message);
    throw err;
  }
}

async function getThresholdSettings(userIdInput = DEFAULT_USER_ID) {
  const userId = resolveUserId(userIdInput);
  const appSettings = await getAppSettings();
  const userSettings = await getUserSettings(userId, { appSettings, createIfMissing: true });

  return {
    aqi: appSettings.threshold_aqi,
    uv: appSettings.threshold_uv,
    bmp_temp: userSettings.temp_threshold,
    pressure: userSettings.pressure_threshold,
    rain_percentage: appSettings.threshold_rain_percentage,
    humidity_threshold: userSettings.humidity_threshold
  };
}

async function setThresholdSettings(payload, userIdInput = DEFAULT_USER_ID) {
  const userId = resolveUserId(userIdInput);
  const aqi = safeNumber(payload?.aqi);
  const uv = safeNumber(payload?.uv);
  const bmpTemp = safeNumber(payload?.bmp_temp);
  const pressure = safeNumber(payload?.pressure);
  const rainPercentage = safeNumber(payload?.rain_percentage);
  const humidityThreshold = safeNumber(payload?.humidity_threshold, null);

  if (
    !Number.isFinite(aqi) ||
    !Number.isFinite(uv) ||
    !Number.isFinite(bmpTemp) ||
    !Number.isFinite(pressure) ||
    !Number.isFinite(rainPercentage)
  ) {
    throw makeHttpError(400, 'Invalid threshold payload');
  }

  await getAppSettings();

  const appUpdatePayload = {
    threshold_aqi: Math.round(aqi),
    threshold_uv: uv,
    threshold_bmp_temp: bmpTemp,
    threshold_pressure: Math.round(pressure),
    threshold_rain_percentage: Math.round(rainPercentage),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('app_settings')
    .update(appUpdatePayload)
    .eq('key', APP_SETTINGS_KEY);

  if (error) {
    console.error('[settings] failed to update app thresholds:', error.message);
    throw error;
  }

  const userUpdatePayload = {
    temp_threshold: bmpTemp,
    pressure_threshold: Math.round(pressure)
  };
  if (Number.isFinite(humidityThreshold)) {
    userUpdatePayload.humidity_threshold = humidityThreshold;
  }
  await upsertUserSettings(userId, userUpdatePayload);

  return getThresholdSettings(userId);
}

async function getNotificationSettings(userIdInput = DEFAULT_USER_ID) {
  const userId = resolveUserId(userIdInput);
  const appSettings = await getAppSettings();
  const userSettings = await getUserSettings(userId, { appSettings, createIfMissing: true });

  return {
    report_times: appSettings.report_times,
    alert_rate: appSettings.alert_rate,
    rate: appSettings.alert_rate,
    timezone: appSettings.timezone,
    notification_enabled: userSettings.notification_enabled,
    notify_start_time: userSettings.notify_start_time,
    notify_end_time: userSettings.notify_end_time,
    last_alert_sent: userSettings.last_alert_sent
  };
}

async function setNotificationSettings(payload, userIdInput = DEFAULT_USER_ID) {
  const userId = resolveUserId(userIdInput);
  const reportTimes = normalizeTimes(payload?.report_times);
  if (reportTimes.length === 0) {
    throw makeHttpError(400, 'report_times must contain at least one valid HH:MM value');
  }

  const requestedRate = String(payload?.alert_rate ?? payload?.rate ?? '').trim();
  const alertRate = requestedRate || DEFAULT_APP_SETTINGS.alert_rate;
  if (!ALLOWED_ALERT_RATES.has(alertRate)) {
    throw makeHttpError(400, 'Invalid alert_rate');
  }

  await getAppSettings();

  const timezone = String(payload?.timezone || DEFAULT_APP_SETTINGS.timezone).trim() || DEFAULT_APP_SETTINGS.timezone;
  const appUpdatePayload = {
    report_times: reportTimes,
    alert_rate: alertRate,
    timezone,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('app_settings')
    .update(appUpdatePayload)
    .eq('key', APP_SETTINGS_KEY);

  if (error) {
    console.error('[settings] failed to update notification settings:', error.message);
    throw error;
  }

  const derivedWindow = deriveWindowFromReportTimes(reportTimes);
  const notifyStart = normalizeTimeValue(payload?.notify_start_time, derivedWindow.notify_start_time);
  const notifyEnd = normalizeTimeValue(payload?.notify_end_time, derivedWindow.notify_end_time);
  const notificationEnabled = typeof payload?.notification_enabled === 'boolean'
    ? payload.notification_enabled
    : DEFAULT_USER_SETTINGS.notification_enabled;

  await upsertUserSettings(userId, {
    notification_enabled: notificationEnabled,
    notify_start_time: notifyStart,
    notify_end_time: notifyEnd,
    alert_cooldown_minutes: getRateCooldownMinutes(alertRate)
  });

  return getNotificationSettings(userId);
}

// =====================================================
// SENSOR DATA
// =====================================================

async function insertSensorData(data) {
  try {
    const { error } = await supabase
      .from('sensor_data')
      .insert([data]);

    if (error) {
      console.error('[sensor] insert sensor_data failed:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[sensor] insert sensor_data exception:', err.message);
    return false;
  }
}

async function insertSensorLog({ userId, temperature, humidity, pressure }) {
  const payload = {
    user_id: resolveUserId(userId),
    temperature: safeNumber(temperature),
    humidity: safeNumber(humidity),
    pressure: safeNumber(pressure)
  };

  try {
    const { error } = await supabase
      .from('sensor_logs')
      .insert([payload]);

    if (error) {
      if (isMissingRelationError(error, 'sensor_logs')) {
        console.warn('[sensor] sensor_logs table missing; skipping sensor_logs insert');
        return false;
      }
      console.error('[sensor] insert sensor_logs failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[sensor] insert sensor_logs exception:', err.message);
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
      if (isMissingRelationError(error, 'sensor_data')) {
        console.warn('[sensor] sensor_data table missing; attempting sensor_logs fallback');
        const { data: logData, error: logError } = await supabase
          .from('sensor_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (logError || !logData) return null;
        return normalizeSensorData({
          bmp_temp: logData.temperature,
          dht_temp: logData.temperature,
          humidity: logData.humidity,
          pressure: logData.pressure,
          created_at: logData.created_at
        });
      }
      console.error('[sensor] get latest failed:', error.message);
      return null;
    }

    return normalizeSensorData(data);
  } catch (err) {
    console.error('[sensor] get latest exception:', err.message);
    return null;
  }
}

async function getGraphData({ metric, range, userId }) {
  const requestedMetric = String(metric || '').trim() || 'bmp_temp';
  const metricConfig = GRAPH_METRIC_MAP[requestedMetric];
  if (!metricConfig) {
    throw makeHttpError(400, `Unsupported metric: ${requestedMetric}`);
  }

  const { startIso, endIso, limit } = resolveRangeWindow(range);
  const scopedUserId = resolveUserId(userId);

  async function queryGraphRows(table, column, scoped) {
    let query = supabase
      .from(table)
      .select(`created_at, ${column}`)
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (scoped) query = query.eq('user_id', scopedUserId);
    return query;
  }

  let data = null;
  let error = null;

  try {
    const result = await queryGraphRows(metricConfig.table, metricConfig.column, metricConfig.table === 'sensor_logs');
    data = result.data;
    error = result.error;
  } catch (err) {
    error = err;
  }

  if (error && metricConfig.fallbackTable) {
    console.warn(`[graph] primary query failed for ${requestedMetric}, trying fallback:`, error.message);
    const fallback = await queryGraphRows(metricConfig.fallbackTable, metricConfig.fallbackColumn, false);
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    if (isMissingRelationError(error, metricConfig.table) || isMissingRelationError(error, metricConfig.fallbackTable)) {
      console.warn('[graph] source table missing, returning empty dataset');
      return [];
    }
    console.error('[graph] query failed:', error.message);
    throw error;
  }

  const points = (data || [])
    .map((row) => ({
      created_at: row.created_at,
      value: safeNumber(row[metricConfig.column], safeNumber(row[metricConfig.fallbackColumn]))
    }))
    .filter((row) => row.created_at && Number.isFinite(row.value));

  return points;
}

// =====================================================
// NOTIFICATIONS
// =====================================================

async function insertWebNotification(title, message, type = 'info', options = {}) {
  const payload = {
    title,
    message,
    type,
    is_read: false
  };

  if (options.userId) payload.user_id = resolveUserId(options.userId);

  try {
    let { error } = await supabase
      .from('notifications')
      .insert([payload]);

    if (error && options.userId && String(error.message || '').toLowerCase().includes('user_id')) {
      // Backward compatible retry if notifications table does not yet have user_id.
      const retryPayload = { title, message, type, is_read: false };
      ({ error } = await supabase.from('notifications').insert([retryPayload]));
    }

    if (error) {
      console.error('[notifications] insert failed:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[notifications] insert exception:', err.message);
    return false;
  }
}

async function getWebNotifications(limit = 20, userIdInput = null) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const scopedUserId = userIdInput ? resolveUserId(userIdInput) : null;

  try {
    let query = supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (scopedUserId) {
      query = query.eq('user_id', scopedUserId);
    }

    let { data, error } = await query;

    if (error && scopedUserId && String(error.message || '').toLowerCase().includes('user_id')) {
      // Backward compatibility for old notifications table without user_id.
      ({ data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(safeLimit));
    }

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
// ALERT ENGINE
// =====================================================

async function logAlertEvent({ userId, alertType, value, threshold }) {
  const payload = {
    user_id: resolveUserId(userId),
    alert_type: alertType,
    value,
    threshold
  };

  try {
    const { error } = await supabase
      .from('alert_logs')
      .insert([payload]);

    if (error) {
      if (isMissingRelationError(error, 'alert_logs')) {
        console.warn('[alerts] alert_logs table missing; skipping alert log insert');
        return false;
      }
      console.error('[alerts] failed to log alert:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[alerts] alert log exception:', err.message);
    return false;
  }
}

async function processThresholdAlerts({ userId: userIdInput, sensorData }) {
  const userId = resolveUserId(userIdInput);
  const appSettings = await getAppSettings();
  const userSettings = await getUserSettings(userId, { appSettings, createIfMissing: true });

  if (!userSettings.notification_enabled) {
    return { triggered: false, reason: 'notifications-disabled' };
  }

  const timezone = appSettings.timezone || DEFAULT_TIMEZONE;
  const nowTime = getCurrentTimeInTimezone(timezone);
  if (!isWithinTimeWindow(nowTime, userSettings.notify_start_time, userSettings.notify_end_time)) {
    return { triggered: false, reason: 'outside-notification-window' };
  }

  const temperature = safeNumber(sensorData?.bmp_temp ?? sensorData?.temperature);
  const humidity = safeNumber(sensorData?.humidity);
  const pressure = safeNumber(sensorData?.pressure);

  const alerts = [];
  if (Number.isFinite(temperature) && temperature >= userSettings.temp_threshold) {
    alerts.push({
      type: 'temperature_high',
      label: 'Temperature',
      value: temperature,
      threshold: userSettings.temp_threshold
    });
  }
  if (Number.isFinite(humidity) && humidity >= userSettings.humidity_threshold) {
    alerts.push({
      type: 'humidity_high',
      label: 'Humidity',
      value: humidity,
      threshold: userSettings.humidity_threshold
    });
  }
  if (Number.isFinite(pressure) && Number.isFinite(userSettings.pressure_threshold) && pressure <= userSettings.pressure_threshold) {
    alerts.push({
      type: 'pressure_low',
      label: 'Pressure',
      value: pressure,
      threshold: userSettings.pressure_threshold
    });
  }

  if (alerts.length === 0) {
    return { triggered: false, reason: 'no-threshold-crossing' };
  }

  const cooldownMs = getRateCooldownMs(appSettings.alert_rate, userSettings.alert_cooldown_minutes);
  if (userSettings.last_alert_sent) {
    const lastSentTs = Date.parse(userSettings.last_alert_sent);
    if (Number.isFinite(lastSentTs) && (Date.now() - lastSentTs) < cooldownMs) {
      return { triggered: false, reason: 'cooldown-active' };
    }
  }

  const alertLines = alerts.map((a) => `${a.label}: ${a.value.toFixed(1)} (threshold ${a.threshold})`);
  const message = `Threshold crossed - ${alertLines.join(', ')}`;

  for (const alert of alerts) {
    await logAlertEvent({
      userId,
      alertType: alert.type,
      value: alert.value,
      threshold: alert.threshold
    });
  }

  await insertWebNotification('Threshold Alert', message, 'alert', { userId });
  await upsertUserSettings(userId, { last_alert_sent: new Date().toISOString() });

  return {
    triggered: true,
    reason: 'threshold-crossed',
    message,
    alerts
  };
}

// =====================================================
// SHARING
// =====================================================

function buildShareLinks(userIdInput, requestOrigin) {
  const userId = resolveUserId(userIdInput);
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'your_bot_username').trim();

  const origin = String(process.env.RENDER_EXTERNAL_URL || requestOrigin || '').trim().replace(/\/$/, '');
  const dashboardBase = origin || 'http://localhost:10000';
  const dashboardLink = `${dashboardBase}/?user_id=${encodeURIComponent(userId)}`;
  const telegramDeepLink = `https://t.me/${botUsername}?start=${encodeURIComponent(userId)}`;

  return {
    user_id: userId,
    bot_username: botUsername,
    dashboard_link: dashboardLink,
    telegram_deep_link: telegramDeepLink
  };
}

module.exports = {
  supabase,
  DEFAULT_USER_ID,
  insertSensorData,
  insertSensorLog,
  getLatestSensorData,
  getGraphData,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead,
  getAppSettings,
  getUserSettings,
  getThresholdSettings,
  setThresholdSettings,
  getNotificationSettings,
  setNotificationSettings,
  processThresholdAlerts,
  buildShareLinks
};
