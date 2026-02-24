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
  DEFAULT_USER_ID,
  getLatestSensorData,
  getGraphData,
  getWebNotifications,
  markNotificationRead,
  getThresholdSettings,
  setThresholdSettings,
  getNotificationSettings,
  setNotificationSettings,
  buildShareLinks
} = require('./services/supabaseClient');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function resolveUserId(req) {
  const fromQuery = String(req.query?.user_id || '').trim();
  const fromBody = String(req.body?.user_id || '').trim();
  return fromQuery || fromBody || DEFAULT_USER_ID;
}

function resolveOrigin(req) {
  const host = req.get('host');
  if (!host) return process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  return `${req.protocol}://${host}`;
}

// ===============================
// ROUTES
// ===============================

app.get('/api/data', async (req, res) => {
  try {
    const data = await getLatestSensorData();
    if (!data) return res.status(204).send();
    res.json(data);
  } catch (err) {
    console.error('[api/data] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch latest data' });
  }
});

app.get('/api/graph-data', async (req, res) => {
  try {
    const points = await getGraphData({
      metric: req.query?.type,
      range: req.query?.range,
      userId: resolveUserId(req)
    });
    res.json(points);
  } catch (err) {
    const status = err?.statusCode === 400 ? 400 : 500;
    const message = status === 400 ? err.message : 'Failed to fetch graph data';
    if (status === 500) console.error('[api/graph-data] failed:', err.message);
    res.status(status).json({ error: message });
  }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const data = await getWebNotifications(req.query?.limit, resolveUserId(req));
    res.json(data);
  } catch (err) {
    console.error('[api/notifications] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/notifications/read/:id', async (req, res) => {
  try {
    await markNotificationRead(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/notifications/read] failed:', err.message);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

app.get('/api/get-thresholds', async (req, res) => {
  try {
    const data = await getThresholdSettings(resolveUserId(req));
    res.json(data);
  } catch (err) {
    console.error('[api/get-thresholds] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch thresholds' });
  }
});

app.post('/api/set-thresholds', async (req, res) => {
  try {
    const data = await setThresholdSettings(req.body, resolveUserId(req));
    res.json({ ok: true, data });
  } catch (err) {
    const status = err?.statusCode === 400 ? 400 : 500;
    const message = status === 400 ? err.message : 'Failed to save thresholds';
    if (status === 500) console.error('[api/set-thresholds] failed:', err.message);
    res.status(status).json({ error: message });
  }
});

app.get('/api/get-report-time', async (req, res) => {
  try {
    const data = await getNotificationSettings(resolveUserId(req));
    res.json(data);
  } catch (err) {
    console.error('[api/get-report-time] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch report settings' });
  }
});

app.post('/api/save-settings', async (req, res) => {
  try {
    const data = await setNotificationSettings(req.body, resolveUserId(req));
    res.json({ ok: true, data });
  } catch (err) {
    const status = err?.statusCode === 400 ? 400 : 500;
    const message = status === 400 ? err.message : 'Failed to save settings';
    if (status === 500) console.error('[api/save-settings] failed:', err.message);
    res.status(status).json({ error: message });
  }
});

app.get('/api/share-link', async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const links = buildShareLinks(userId, resolveOrigin(req));
    res.json(links);
  } catch (err) {
    console.error('[api/share-link] failed:', err.message);
    res.status(500).json({ error: 'Failed to build share link' });
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
    console.log(`[server] running on ${PORT}`);
  });
}

startServer();
