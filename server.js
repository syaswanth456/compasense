// =====================================================
// Supabase Client Service (Production Ready)
// =====================================================

const { createClient } = require('@supabase/supabase-js');

// =====================================================
// ENV VARIABLES (Render / .env)
// =====================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // ✅ SERVICE ROLE KEY

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Supabase ENV variables missing!");
}

// =====================================================
// CREATE CLIENT
// =====================================================

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

// =====================================================
// SENSOR DATA
// =====================================================

async function insertSensorData(data) {
  try {
    const { error } = await supabase
      .from('sensor_readings') // ✅ CORRECT TABLE
      .insert([data]);

    if (error) {
      console.error('❌ Sensor insert error:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('❌ Sensor insert exception:', err.message);
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

    if (error) return null;
    return data;
  } catch {
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

    const { data, error } = await supabase
      .from('sensor_readings')
      .select(`created_at, ${type}`)
      .gt('created_at', startTime.toISOString())
      .order('created_at', { ascending: true });

    if (error) return [];

    return (data || []).map(r => ({
      created_at: r.created_at,
      value: Number(r[type]) || 0
    }));

  } catch {
    return [];
  }
}

// =====================================================
// 🔔 WEB NOTIFICATIONS
// =====================================================

async function insertWebNotification(title, message, type = 'info') {
  try {
    const { error } = await supabase
      .from('web_notifications') // ✅ CORRECT TABLE
      .insert([{ title, message, type, is_read: false }]);

    if (error) {
      console.error('❌ Notification insert error:', error.message);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function getWebNotifications(limit = 20) {
  try {
    const { data, error } = await supabase
      .from('web_notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

async function markNotificationRead(id) {
  await supabase
    .from('web_notifications')
    .update({ is_read: true })
    .eq('id', id);
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  supabase,
  insertSensorData,
  getLatestSensorData,
  getHistoricalData,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead
};
