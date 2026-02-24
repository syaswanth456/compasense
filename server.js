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
  getVapidPublicKey,
  savePushSubscription,
  deactivatePushSubscription,
  upsertTelegramSubscriber,
  setTelegramSubscription,
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

app.get('/api/push/vapid-public-key', async (_req, res) => {
  try {
    const key = await getVapidPublicKey();
    res.json({ publicKey: key });
  } catch (err) {
    const status = err?.statusCode === 503 ? 503 : 500;
    const message = status === 503 ? err.message : 'Failed to fetch VAPID public key';
    if (status === 500) console.error('[api/push/vapid-public-key] failed:', err.message);
    res.status(status).json({ error: message });
  }
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    await savePushSubscription({
      userId: resolveUserId(req),
      subscription: req.body?.subscription
    });
    res.json({ ok: true });
  } catch (err) {
    const status = err?.statusCode === 400 || err?.statusCode === 503 ? err.statusCode : 500;
    const message = status === 500 ? 'Failed to save push subscription' : err.message;
    if (status === 500) console.error('[api/push/subscribe] failed:', err.message);
    res.status(status).json({ error: message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    await deactivatePushSubscription(req.body?.endpoint);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/push/unsubscribe] failed:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe push endpoint' });
  }
});

// ===============================
// TELEGRAM WEBHOOK
// ===============================

app.post('/api/telegram-webhook', async (req, res) => {
  const bot = getBotInstance();
  const msg = req.body?.message;

  if (bot && msg?.chat?.id && msg?.text) {
    const text = String(msg.text).trim().toLowerCase();

    if (text.startsWith('/start')) {
      await upsertTelegramSubscriber({
        chatId: msg.chat.id,
        firstName: msg.chat.first_name,
        username: msg.chat.username,
        isSubscribed: true
      });
      await bot.sendMessage(
        msg.chat.id,
        'Subscribed to CampusSense alerts. Use /status for latest reading or /stop to unsubscribe.'
      );
    } else if (text === '/stop') {
      await setTelegramSubscription(msg.chat.id, false);
      await bot.sendMessage(msg.chat.id, 'Unsubscribed from CampusSense alerts.');
    } else if (text === '/status') {
      const latest = await getLatestSensorData();
      await bot.sendMessage(msg.chat.id, formatStatus(latest));
    }
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
