// services/supabaseClient.js

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ===============================
// ENV VALIDATION
// ===============================

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("❌ FATAL: Supabase environment variables missing");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    auth: { persistSession: false }
  }
);

// ===============================
// SENSOR READINGS
// ===============================

async function insertSensorData(data) {
  try {
    const { error } = await supabase
      .from('sensor_readings')
      .insert([data]);

    if (error) {
      console.error('❌ Supabase Insert Error:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('❌ Insert crash:', err);
    return false;
  }
}

async function getLatestSensorData() {
  try {
    const { data, error } = await supabase
      .from('sensor_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('❌ Supabase Latest Error:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error('❌ Latest fetch crash:', err);
    return null;
  }
}

async function getHistoricalData(type, range) {
  try {
    const now = new Date();
    let startTime;

    switch (range) {
      case '5m':
        startTime = new Date(now.getTime() - 5 * 60 * 1000);
        break;
      case '1h':
        startTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      default:
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    const valid = [
      'bmp_temp',
      'dht_temp',
      'humidity',
      'aqi',
      'uv',
      'light_level',
      'pressure',
      'rain_percentage'
    ];

    if (!valid.includes(type)) {
      console.error(`❌ Invalid history type: ${type}`);
      return [];
    }

    const { data, error } = await supabase
      .from('sensor_readings')
      .select(`created_at, ${type}`)
      .gt('created_at', startTime.toISOString())
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ History Fetch Error:', error.message);
      return [];
    }

    // normalize for charts
    return (data || []).map(row => ({
      created_at: row.created_at,
      value: Number(row[type]) || 0
    }));

  } catch (err) {
    console.error('❌ History crash:', err);
    return [];
  }
}

// ===============================
// TELEGRAM SUBSCRIBERS
// ===============================

async function addSubscriber(userInfo) {
  try {
    const { error } = await supabase
      .from('telegram_subscribers')
      .upsert({
        chat_id: userInfo.chat_id,
        first_name: userInfo.first_name,
        username: userInfo.username,
        is_subscribed: true
      }, { onConflict: 'chat_id' });

    if (error) {
      console.error('❌ Sub Add Error:', error.message);
    } else {
      console.log('✅ Subscriber updated:', userInfo.chat_id);
    }
  } catch (err) {
    console.error('❌ Subscriber crash:', err);
  }
}

async function updateSubscription(chat_id, status) {
  try {
    const { error } = await supabase
      .from('telegram_subscribers')
      .update({ is_subscribed: status })
      .eq('chat_id', chat_id);

    if (error) {
      console.error('❌ Sub Update Error:', error.message);
    }
  } catch (err) {
    console.error('❌ Sub update crash:', err);
  }
}

async function getSubscribers() {
  try {
    const { data, error } = await supabase
      .from('telegram_subscribers')
      .select('chat_id')
      .eq('is_subscribed', true);

    if (error) {
      console.error('❌ Sub Fetch Error:', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('❌ Sub fetch crash:', err);
    return [];
  }
}

// ===============================
// ALERT THRESHOLDS
// ===============================

async function getThresholds() {
  try {
    const { data, error } = await supabase
      .from('alert_thresholds')
      .select('metric, threshold_value, alert_if_above');

    if (error) {
      console.error('❌ Threshold Fetch Error:', error.message);
      return null;
    }

    const map = {};

    (data || []).forEach(i => {
      map[i.metric] = {
        value: parseFloat(i.threshold_value),
        alert_if_above: i.alert_if_above
      };
    });

    return map;
  } catch (err) {
    console.error('❌ Threshold crash:', err);
    return null;
  }
}

async function updateThresholds(thresholds) {
  try {
    const updates = [];

    for (const m in thresholds) {
      const val = Number(thresholds[m]);

      if (!isNaN(val)) {
        updates.push({
          metric: m,
          threshold_value: val,
          updated_at: new Date().toISOString()
        });
      }
    }

    if (updates.length === 0) return true;

    const { error } = await supabase
      .from('alert_thresholds')
      .upsert(updates, { onConflict: 'metric' });

    if (error) {
      console.error('❌ Threshold Update Error:', error.message);
      return false;
    }

    console.log(`✅ Updated ${updates.length} thresholds`);
    return true;

  } catch (err) {
    console.error('❌ Threshold update crash:', err);
    return false;
  }
}

// ===============================
// DAILY REPORT SCHEDULE
// ===============================

async function getAllReportScheduleTimes() {
  try {
    const { data, error } = await supabase
      .from('scheduled_reports')
      .select('report_time')
      .eq('is_active', true)
      .order('report_time', { ascending: true });

    if (error) {
      console.error('❌ Schedule Fetch Error:', error.message);
      return ['08:00'];
    }

    return data?.map(i => i.report_time) || ['08:00'];
  } catch (err) {
    console.error('❌ Schedule crash:', err);
    return ['08:00'];
  }
}

async function updateAllReportScheduleTimes(newTimes) {
  try {
    // safer delete
    const { error: delErr } = await supabase
      .from('scheduled_reports')
      .delete()
      .not('id', 'is', null);

    if (delErr) {
      console.error('❌ Schedule Delete Error:', delErr.message);
      return false;
    }

    const newSchedules = newTimes.map(t => ({
      report_time: t,
      is_active: true
    }));

    const { error: insErr } = await supabase
      .from('scheduled_reports')
      .insert(newSchedules);

    if (insErr) {
      console.error('❌ Schedule Insert Error:', insErr.message);
      return false;
    }

    console.log(`✅ Updated schedules: ${newTimes.join(', ')}`);
    return true;

  } catch (err) {
    console.error('❌ Schedule update crash:', err);
    return false;
  }
}

// ===============================
// EXPORTS
// ===============================

module.exports = {
  insertSensorData,
  getLatestSensorData,
  getHistoricalData,
  addSubscriber,
  updateSubscription,
  getSubscribers,
  getThresholds,
  updateThresholds,
  getAllReportScheduleTimes,
  updateAllReportScheduleTimes
};
