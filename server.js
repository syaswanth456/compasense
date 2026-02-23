require('dotenv').config();

const express = require('express');
const path = require('path');
const cron = require('node-cron');

const { startMqttClient } = require('./services/mqttClient');

const {
  getSubscribers,
  getLatestSensorData,
  getHistoricalData,
  addSubscriber,
  updateSubscription,
  getThresholds,
  updateThresholds,
  getAllReportScheduleTimes,
  updateAllReportScheduleTimes,
  insertWebNotification,
  getWebNotifications,
  markNotificationRead
} = require('./services/supabaseClient');

const {
  startTelegramBot,
  getBotInstance,
  formatLatestData,
  sendStructuredAlert
} = require('./services/telegramBot');

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// MIDDLEWARE
// ===============================

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// homepage fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===============================
// STATE
// ===============================

let ALERT_THRESHOLDS = {};
let currentAlertState = {};
const REQUIRED_CONSECUTIVE_READINGS = 2;

let dailyReportScheduleTimes = [];
let dailyReportCronJobs = [];

// ===============================
// TELEGRAM WEBHOOK
// ===============================

app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;
  const bot = getBotInstance();

  try {
    if (update?.message?.text && bot) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text;

      console.log(`📩 Telegram: ${text} from ${chatId}`);

      if (text === '/start') {
        await addSubscriber({
          chat_id: chatId,
          first_name: msg.chat.first_name || 'User',
          username: msg.chat.username
        });

        await bot.sendMessage(
          chatId,
          `Welcome! ✌️\n\nCommands:\n/status\n/stop`,
          { parse_mode: 'Markdown' }
        );
      }

      else if (text === '/stop') {
        await updateSubscription(chatId, false);
        await bot.sendMessage(chatId, 'Unsubscribed.');
      }

      else if (text === '/status') {
        const latest = await getLatestSensorData();
        const msgText = formatLatestData(latest);
        await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
      }

      else {
        await bot.sendMessage(chatId, 'Unknown command.');
      }
    }
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }

  res.sendStatus(200);
});

// ===============================
// DASHBOARD APIs
// ===============================

// latest data
app.get('/api/data', async (req, res) => {
  try {
    const d = await getLatestSensorData();
    if (!d) return res.status(204).send();
    res.json(d);
  } catch (e) {
    console.error('/api/data error:', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// graph data
app.get('/api/graph-data', async (req, res) => {
  const { type, range } = req.query;

  if (!type || !range) {
    return res.status(400).json({ error: 'Missing params' });
  }

  try {
    const d = await getHistoricalData(type, range);
    res.json(d || []);
  } catch (e) {
    console.error('/api/graph-data error:', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ===============================
// 🔔 WEB NOTIFICATIONS
// ===============================

app.get('/api/notifications', async (req, res) => {
  try {
    const data = await getWebNotifications();
    res.json(data);
  } catch (e) {
    console.error('Notification fetch error:', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.post('/api/notifications/read/:id', async (req, res) => {
  try {
    await markNotificationRead(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Notification update error:', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ===============================
// ⚙️ THRESHOLDS
// ===============================

app.get('/api/get-thresholds', async (req, res) => {
  try {
    const t = Object.keys(ALERT_THRESHOLDS).length
      ? ALERT_THRESHOLDS
      : await getThresholds();

    res.json(t || {});
  } catch (e) {
    console.error('/api/get-thresholds error:', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.post('/api/set-thresholds', async (req, res) => {
  try {
    const success = await updateThresholds(req.body);

    if (success) {
      await loadThresholdsFromDB();
      return res.json({ message: 'Updated' });
    }

    res.status(500).json({ error: 'DB update failed' });
  } catch (e) {
    console.error('/api/set-thresholds error:', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ===============================
// 📅 REPORT TIMES
// ===============================

app.get('/api/get-report-time', (req, res) => {
  res.json({ report_times: dailyReportScheduleTimes });
});

app.post('/api/set-report-time', async (req, res) => {
  try {
    const success = await updateAllReportScheduleTimes(req.body.report_times);

    if (success) {
      await loadAndScheduleReports();
      return res.json({ message: 'Updated' });
    }

    res.status(500).json({ error: 'DB update failed' });
  } catch (e) {
    console.error('/api/set-report-time error:', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ===============================
// 🚨 ALERT ENGINE
// ===============================

async function sendAlertToAll(messages) {
  const subs = await getSubscribers();
  const chatIds = subs.map(s => s.chat_id);

  await sendStructuredAlert(chatIds, 'ALERT', messages);

  // also save to bell
  for (const msg of messages) {
    await insertWebNotification('System Alert', msg, 'alert');
  }
}

function checkThresholdAndState(metricName, stateKey, currentValue) {
  if (!ALERT_THRESHOLDS?.[metricName]) return null;
  if (typeof currentValue !== 'number') return null;

  const tInfo = ALERT_THRESHOLDS[metricName];
  const tVal = tInfo.value;
  const alertIfAbove = tInfo.alert_if_above;

  const state = currentAlertState[stateKey];
  const isMet = alertIfAbove
    ? currentValue > tVal
    : currentValue < tVal;

  let alertMsg = null;

  if (isMet) {
    if (!state.alarming) {
      state.consecutiveCount++;

      if (state.consecutiveCount >= REQUIRED_CONSECUTIVE_READINGS) {
        state.alarming = true;
        state.consecutiveCount = 0;

        const comp = alertIfAbove ? 'Above' : 'Below';

        switch (metricName) {
          case 'aqi':
            alertMsg = `AQI WARNING: ${currentValue} (${comp} ${tVal})`;
            break;
          case 'uv':
            alertMsg = `HIGH UV: ${currentValue} (${comp} ${tVal})`;
            break;
          case 'bmp_temp':
            alertMsg = `HIGH TEMP: ${currentValue}°C (${comp} ${tVal})`;
            break;
          case 'pressure':
            alertMsg = `LOW PRESSURE: ${currentValue} hPa (${comp} ${tVal})`;
            break;
          case 'rain_percentage':
            alertMsg = `HEAVY RAIN: ${currentValue}% (${comp} ${tVal})`;
            break;
        }
      }
    }
  } else {
    state.consecutiveCount = 0;
    state.alarming = false;
  }

  return alertMsg;
}

const alertingEngine = {
  checkForAlerts(data) {
    if (!Object.keys(ALERT_THRESHOLDS).length) return;

    const msgs = [];

    const checks = [
      ['aqi', 'aqi', data.aqi],
      ['uv', 'uv', data.uv],
      ['bmp_temp', 'bmp_temp', data.bmp_temp],
      ['pressure', 'pressure', data.pressure],
      ['rain_percentage', 'rain', data.rain_percentage]
    ];

    for (const [metric, key, val] of checks) {
      const msg = checkThresholdAndState(metric, key, val);
      if (msg) msgs.push(msg);
    }

    if (msgs.length) {
      console.log('🚨 Alerts triggered');
      sendAlertToAll(msgs);
    }
  }
};

// ===============================
// INIT
// ===============================

async function loadThresholdsFromDB() {
  const tFromDB = await getThresholds();

  if (tFromDB) {
    ALERT_THRESHOLDS = tFromDB;
    currentAlertState = {};

    Object.keys(ALERT_THRESHOLDS).forEach(m => {
      const sk = m === 'rain_percentage' ? 'rain' : m;
      currentAlertState[sk] = { alarming: false, consecutiveCount: 0 };
    });
  }
}

async function sendDailyReport() {
  try {
    const subs = await getSubscribers();
    const chatIds = subs.map(s => s.chat_id);
    const data = await getLatestSensorData();

    if (data && chatIds.length) {
      await sendStructuredAlert(chatIds, 'REPORT', [formatLatestData(data)]);
    }
  } catch (e) {
    console.error('Daily report error:', e);
  }
}

function scheduleDailyReports(times) {
  dailyReportCronJobs.forEach(j => j.stop());
  dailyReportCronJobs = [];

  dailyReportScheduleTimes = times;

  times.forEach(t => {
    const [h, m] = t.split(':');
    const cronEx = `${m} ${h} * * *`;

    const job = cron.schedule(cronEx, sendDailyReport, {
      timezone: 'Asia/Kolkata'
    });

    dailyReportCronJobs.push(job);
  });
}

async function loadAndScheduleReports() {
  const times = await getAllReportScheduleTimes();
  scheduleDailyReports(times);
}

// ===============================
// START
// ===============================

async function initializeApp() {
  try {
    await loadThresholdsFromDB();
    await loadAndScheduleReports();
    await startTelegramBot();
    startMqttClient(alertingEngine);

    app.listen(PORT, () => {
      console.log(`✅ Server running on ${PORT}`);
    });
  } catch (e) {
    console.error('CRITICAL INIT ERROR:', e);
    process.exit(1);
  }
}

initializeApp();
