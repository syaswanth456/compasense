// =====================================================
// Supabase Client Service (Production Ready)
// =====================================================

const { createClient } = require('@supabase/supabase-js');

// =====================================================
// ENV VARIABLES (Render / .env)
// =====================================================

// ✅ MUST use SERVICE ROLE key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ FATAL: Supabase ENV variables missing!");
}

// =====================================================
// CREATE CLIENT
// =====================================================

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

// =====================================================
// 📡 SENSOR DATA
// Table: sensor_data
// =====================================================

async function insertSensorData(data) {
  try {
    const { error } = await supabase
      .from('sensor_data') // ✅ MATCHES YOUR SQL
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
      .from('sensor_data') // ✅ MATCHES YOUR SQL
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
    console.error('❌ Latest fetch exception:', err.message);
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
      .from('sensor_data') // ✅ MATCHES YOUR SQL
      .select(`created_at, ${type}`)
      .gt('created_at', startTime.toISOString())
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ History fetch error:', error.message);
      return [];
    }

    // normalize for charts
    return (data || []).map(row => ({
      created_at: row.created_at,
      value: Number(row[type]) || 0
    }));

  } catch (err) {
    console.error('❌ History exception:', err.message);
    return [];
  }
}

// =====================================================
// 🔔 WEB NOTIFICATIONS (Bell)
// Table: notifications
// =====================================================

async function insertWebNotification(title, message, type = 'info') {
  try {
    const { error } = await supabase
      .from('notifications') // ✅ MATCHES YOUR SQL
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
      .from('notifications') // ✅ MATCHES YOUR SQL
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('❌ Notification fetch error:', error.message);
      return [];
    }

    return data || [];

  } catch (err) {
    console.error('❌ Notification fetch exception:', err.message);
    return [];
  }
}

async function markNotificationRead(id) {
  try {
    const { error } = await supabase
      .from('notifications') // ✅ MATCHES YOUR SQL
      .update({ is_read: true })
      .eq('id', id);

    if (error) {
      console.error('❌ Notification update error:', error.message);
      return false;
    }

    return true;

  } catch (err) {
    console.error('❌ Notification update exception:', err.message);
    return false;
  }
}

// =====================================================
// 📦 EXPORTS
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
