const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

// ===============================
// 🔔 WEB NOTIFICATIONS
// ===============================

async function insertWebNotification(title, message, type = 'info') {
  const { error } = await supabase
    .from('web_notifications')
    .insert([{ title, message, type, is_read: false }]);

  if (error) console.error('Notif insert error:', error.message);
}

async function getWebNotifications(limit = 20) {
  const { data, error } = await supabase
    .from('web_notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return data || [];
}

async function markNotificationRead(id) {
  await supabase
    .from('web_notifications')
    .update({ is_read: true })
    .eq('id', id);
}

// (keep your existing sensor + subscriber + threshold functions unchanged)

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
  updateAllReportScheduleTimes,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead
};
