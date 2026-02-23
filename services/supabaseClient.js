// =====================================================
// Supabase Client Service (Production Ready)
// =====================================================

const { createClient } = require('@supabase/supabase-js');

// =====================================================
// ENV VARIABLES (Render / .env)
// =====================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Safety check
if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Supabase ENV variables missing!");
}

// =====================================================
// CREATE CLIENT
// =====================================================
const supabase = createClient(supabaseUrl, supabaseKey);

// =====================================================
// INSERT SENSOR DATA
// =====================================================
async function insertSensorData(data) {
  try {
    const { error } = await supabase
      .from('sensor_data') // ⚠️ ensure table name correct
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

// =====================================================
// INSERT WEB NOTIFICATION
// =====================================================
async function insertWebNotification(title, message, type = 'info') {
  try {
    const { error } = await supabase
      .from('notifications') // ⚠️ ensure table exists
      .insert([
        {
          title,
          message,
          type,
          created_at: new Date().toISOString()
        }
      ]);

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

// =====================================================
// GET RECENT SENSOR DATA (optional helper)
// =====================================================
async function getRecentSensorData(limit = 50) {
  try {
    const { data, error } = await supabase
      .from('sensor_data')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('❌ Fetch error:', error.message);
      return [];
    }

    return data;

  } catch (err) {
    console.error('❌ Fetch exception:', err.message);
    return [];
  }
}

// =====================================================
// EXPORTS (VERY IMPORTANT)
// =====================================================
module.exports = {
  supabase,
  insertSensorData,
  insertWebNotification,
  getRecentSensorData
};
