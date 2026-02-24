// =====================================================
// CampusSense Main Server
// =====================================================

require('dotenv').config();

const express = require('express');
const path = require('path');

const {
  startTelegramBot,
  getBotInstance,
  formatStatus
} = require('./services/telegramBot');

const { startMqttClient } = require('./services/mqttClient');

const {
  getLatestSensorData,
  getWebNotifications,
  markNotificationRead,
  getThresholdSettings,
  setThresholdSettings,
  getNotificationSettings,
  setNotificationSettings
} = require('./services/supabaseClient');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===============================
// ROUTES
// ===============================

app.get('/api/data', async (req, res) => {
  const data = await getLatestSensorData();
  if (!data) return res.status(204).send();
  res.json(data);
});

app.get('/api/notifications', async (req, res) => {
  const data = await getWebNotifications();
  res.json(data);
});

app.post('/api/notifications/read/:id', async (req, res) => {
  await markNotificationRead(req.params.id);
  res.json({ ok: true });
});

app.get('/api/get-thresholds', async (req, res) => {
  try {
    const data = await getThresholdSettings();
    res.json(data);
  } catch (err) {
    console.error('Failed to get thresholds:', err.message);
    res.status(500).json({ error: 'Failed to fetch thresholds' });
  }
});

app.post('/api/set-thresholds', async (req, res) => {
  try {
    const data = await setThresholdSettings(req.body);
    res.json({ ok: true, data });
  } catch (err) {
    const status = err?.statusCode === 400 ? 400 : 500;
    const message = status === 400 ? err.message : 'Failed to save thresholds';
    if (status === 500) console.error('Failed to set thresholds:', err.message);
    res.status(status).json({ error: message });
  }
});

app.get('/api/get-report-time', async (req, res) => {
  try {
    const data = await getNotificationSettings();
    res.json(data);
  } catch (err) {
    console.error('Failed to get report settings:', err.message);
    res.status(500).json({ error: 'Failed to fetch report settings' });
  }
});

app.post('/api/save-settings', async (req, res) => {
  try {
    const data = await setNotificationSettings(req.body);
    res.json({ ok: true, data });
  } catch (err) {
    const status = err?.statusCode === 400 ? 400 : 500;
    const message = status === 400 ? err.message : 'Failed to save settings';
    if (status === 500) console.error('Failed to save settings:', err.message);
    res.status(status).json({ error: message });
  }
});

// ===============================
// TELEGRAM WEBHOOK
// ===============================

app.post('/api/telegram-webhook', async (req, res) => {
  const bot = getBotInstance();
  const msg = req.body?.message;

  if (bot && msg?.text === '/status') {
    const latest = await getLatestSensorData();
    await bot.sendMessage(msg.chat.id, formatStatus(latest));
  }

  res.sendStatus(200);
});

// ===============================
// START
// ===============================

function startServer() {
  startTelegramBot();
  startMqttClient();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on ${PORT}`);
  });
}

startServer();
