// =====================================================
// Supabase Client Service (Production Ready)
// =====================================================

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ FATAL: Supabase ENV variables missing!");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

// =====================================================
// 📡 SENSOR READINGS
// =====================================================

async function insertSensorData(data) {
  try {
    const { error } = await supabase
      .from('sensor_data') // ✅ FIXED
      .insert([data]);

    if (error) {
      console.error('❌ Sensor insert error:', error.message);
      return false;
    }

    console.log('✅ Sensor data stored');
    return true;

  } catch (err) {
    console.error('❌ Sensor insert exception:', err.message);
    return false;
  }
}

async function getLatestSensorData() {
  try {
    const { data, error } = await supabase
      .from('sensor_data') // ✅ FIXED
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
      .from('sensor_data') // ✅ FIXED
      .select(`created_at, ${type}`)
      .gt('created_at', startTime.toISOString())
      .order('created_at', { ascending: true });

    if (error) return [];

    return (data || []).map(row => ({
      created_at: row.created_at,
      value: Number(row[type]) || 0
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
      .from('notifications') // ✅ FIXED
      .insert([{ title, message, type, is_read: false }]);

    if (error) return false;
    return true;
  } catch {
    return false;
  }
}

async function getWebNotifications(limit = 20) {
  try {
    const { data, error } = await supabase
      .from('notifications') // ✅ FIXED
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
    .from('notifications') // ✅ FIXED
    .update({ is_read: true })
    .eq('id', id);
}

module.exports = {
  supabase,
  insertSensorData,
  getLatestSensorData,
  getHistoricalData,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead
};
