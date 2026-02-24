// =====================================================
// Supabase Client (FINAL PRODUCTION)
// =====================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

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

module.exports = {
  supabase,
  insertSensorData,
  getLatestSensorData,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead
};
