// =====================================================
// Supabase Client (FINAL PRODUCTION)
// =====================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

const APP_SETTINGS_KEY = 'global';
const DEFAULT_APP_SETTINGS = {
  threshold_aqi: 450,
  threshold_uv: 7.0,
  threshold_bmp_temp: 28.0,
  threshold_pressure: 990,
  threshold_rain_percentage: 70,
  report_times: ['09:00', '12:00', '18:00'],
  alert_rate: 'immediate',
  timezone: 'Asia/Kolkata'
};

const TIME_REGEX = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
const ALLOWED_ALERT_RATES = new Set(['immediate', '15min', '30min', 'hourly']);

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function normalizeTimes(times) {
  if (!Array.isArray(times)) return [];
  const unique = [];
  for (const value of times) {
    if (typeof value !== 'string') continue;
    const time = value.trim();
    if (!TIME_REGEX.test(time)) continue;
    if (!unique.includes(time)) unique.push(time);
  }
  return unique;
}

function normalizeSettingsRow(row) {
  const reportTimes = normalizeTimes(row?.report_times);
  return {
    key: APP_SETTINGS_KEY,
    threshold_aqi: Number(row?.threshold_aqi ?? DEFAULT_APP_SETTINGS.threshold_aqi),
    threshold_uv: Number(row?.threshold_uv ?? DEFAULT_APP_SETTINGS.threshold_uv),
    threshold_bmp_temp: Number(row?.threshold_bmp_temp ?? DEFAULT_APP_SETTINGS.threshold_bmp_temp),
    threshold_pressure: Number(row?.threshold_pressure ?? DEFAULT_APP_SETTINGS.threshold_pressure),
    threshold_rain_percentage: Number(
      row?.threshold_rain_percentage ?? DEFAULT_APP_SETTINGS.threshold_rain_percentage
    ),
    report_times: reportTimes.length > 0 ? reportTimes : [...DEFAULT_APP_SETTINGS.report_times],
    alert_rate: row?.alert_rate || DEFAULT_APP_SETTINGS.alert_rate,
    timezone: row?.timezone || DEFAULT_APP_SETTINGS.timezone
  };
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
      console.error('❌ Sensor insert error:', error.message);
      return false;
    }

    console.log('✅ Sensor data stored');
    return true;
  } catch (err) {
    console.error('❌ Sensor exception:', err.message);
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
      console.error('❌ Latest fetch error:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error('❌ Latest exception:', err.message);
    return null;
  }
}

// =====================================================
// WEB NOTIFICATIONS
// =====================================================

async function insertWebNotification(title, message, type = 'info') {
  try {
    const { error } = await supabase
      .from('notifications')
      .insert([{
        title,
        message,
        type,
        is_read: false
      }]);

    if (error) {
      console.error('❌ Notification insert error:', error.message);
      return false;
    }

    console.log('🔔 Notification stored');
    return true;
  } catch (err) {
    console.error('❌ Notification exception:', err.message);
    return false;
  }
}

async function getWebNotifications(limit = 20) {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('❌ Notification fetch error:', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('❌ Notification exception:', err.message);
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
// APP SETTINGS (GLOBAL)
// =====================================================

async function getAppSettings() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .eq('key', APP_SETTINGS_KEY)
      .maybeSingle();

    if (error) throw error;
    if (data) return normalizeSettingsRow(data);

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
    return normalizeSettingsRow(inserted || insertPayload);
  } catch (err) {
    console.error('App settings fetch error:', err.message);
    throw err;
  }
}

async function getThresholdSettings() {
  const settings = await getAppSettings();
  return {
    aqi: settings.threshold_aqi,
    uv: settings.threshold_uv,
    bmp_temp: settings.threshold_bmp_temp,
    pressure: settings.threshold_pressure,
    rain_percentage: settings.threshold_rain_percentage
  };
}

async function setThresholdSettings(payload) {
  const aqi = Number(payload?.aqi);
  const uv = Number(payload?.uv);
  const bmpTemp = Number(payload?.bmp_temp);
  const pressure = Number(payload?.pressure);
  const rainPercentage = Number(payload?.rain_percentage);

  if (
    !Number.isFinite(aqi) ||
    !Number.isFinite(uv) ||
    !Number.isFinite(bmpTemp) ||
    !Number.isFinite(pressure) ||
    !Number.isFinite(rainPercentage)
  ) {
    throw badRequest('Invalid threshold payload');
  }

  await getAppSettings();
  const updatePayload = {
    threshold_aqi: Math.round(aqi),
    threshold_uv: uv,
    threshold_bmp_temp: bmpTemp,
    threshold_pressure: Math.round(pressure),
    threshold_rain_percentage: Math.round(rainPercentage),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('app_settings')
    .update(updatePayload)
    .eq('key', APP_SETTINGS_KEY);

  if (error) throw error;
  return getThresholdSettings();
}

async function getNotificationSettings() {
  const settings = await getAppSettings();
  return {
    report_times: settings.report_times,
    alert_rate: settings.alert_rate,
    rate: settings.alert_rate,
    timezone: settings.timezone
  };
}

async function setNotificationSettings(payload) {
  const reportTimes = normalizeTimes(payload?.report_times);
  if (reportTimes.length === 0) {
    throw badRequest('report_times must contain at least one valid HH:MM value');
  }

  const requestedRate = (payload?.alert_rate ?? payload?.rate ?? '').toString().trim();
  const alertRate = requestedRate || DEFAULT_APP_SETTINGS.alert_rate;
  if (!ALLOWED_ALERT_RATES.has(alertRate)) {
    throw badRequest('Invalid alert_rate');
  }

  const requestedTimezone = (payload?.timezone ?? '').toString().trim();
  const timezone = requestedTimezone || DEFAULT_APP_SETTINGS.timezone;

  await getAppSettings();
  const updatePayload = {
    report_times: reportTimes,
    alert_rate: alertRate,
    timezone,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('app_settings')
    .update(updatePayload)
    .eq('key', APP_SETTINGS_KEY);

  if (error) throw error;
  return getNotificationSettings();
}

module.exports = {
  supabase,
  insertSensorData,
  getLatestSensorData,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead,
  getAppSettings,
  getThresholdSettings,
  setThresholdSettings,
  getNotificationSettings,
  setNotificationSettings
};
