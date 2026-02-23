// =====================================================
// CampusSense Main Server (Production Ready)
// =====================================================

require('dotenv').config();

const express = require('express');
const path = require('path');

// ===============================
// SERVICES
// ===============================

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

// ===============================
// APP INIT
// ===============================

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// MIDDLEWARE
// ===============================

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================
// 🏠 HEALTH ROUTE
// =====================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================================================
// 📡 API — Latest Sensor Data
// =====================================================

app.get('/api/data', async (req, res) => {
  try {
    const data = await getLatestSensorData();

    if (!data) {
      return res.status(204).send();
    }

    res.json(data);
  } catch (err) {
    console.error("❌ /api/data error:", err.message);
    res.status(500).json({ error: 'fetch failed' });
  }
});

// =====================================================
// 🔔 NOTIFICATIONS API
// =====================================================

// get notifications
app.get('/api/notifications', async (req, res) => {
  try {
    const data = await getWebNotifications();
    res.json(data);
  } catch (err) {
    console.error("❌ notifications fetch error:", err.message);
    res.status(500).json({ error: 'fetch failed' });
  }
});

// mark read
app.post('/api/notifications/read/:id', async (req, res) => {
  try {
    await markNotificationRead(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ notification update error:", err.message);
    res.status(500).json({ error: 'update failed' });
  }
});

// =====================================================
// 🤖 TELEGRAM WEBHOOK
// =====================================================

app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;
  const bot = getBotInstance();

  try {
    if (update?.message?.text && bot) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text;

      console.log("📩 Telegram:", text);

      if (text === '/start') {
        await bot.sendMessage(
          chatId,
          "✅ Subscribed to CampusSense alerts!\nUse /status to check live data."
        );
      }

      else if (text === '/status') {
        const latest = await getLatestSensorData();
        const message = formatStatus(latest);

        await bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown'
        });
      }

      else if (text === '/stop') {
        await bot.sendMessage(chatId, "❌ Unsubscribed.");
      }

      else {
        await bot.sendMessage(chatId, "Unknown command.");
      }
    }
  } catch (err) {
    console.error("❌ Telegram webhook error:", err.message);
  }

  res.sendStatus(200);
});

// =====================================================
// 🚀 START SERVER (CRITICAL)
// =====================================================

async function startServer() {
  console.log("🚀 Starting CampusSense backend...");

  // ✅ start telegram (safe if missing)
  startTelegramBot();

  // ✅ start mqtt
  startMqttClient();

  // ⭐ KEEP SERVER ALIVE (VERY IMPORTANT FOR RENDER)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}

startServer();
