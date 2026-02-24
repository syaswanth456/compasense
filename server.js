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
  markNotificationRead
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
