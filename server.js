// server.js
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
  updateAllReportScheduleTimes
} = require('./services/supabaseClient');

const {
  startTelegramBot,
  getBotInstance,
  formatLatestData,
  sendStructuredAlert
} = require('./services/telegramBot');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===============================
// GLOBAL STATE
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

  if (update?.message?.text && bot) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text;

    console.log(`Received command: ${text} from ${chatId}`);

    try {
      if (text === '/start') {
        const userInfo = {
          chat_id: chatId,
          first_name: msg.chat.first_name || 'User',
          username: msg.chat.username
        };

        await addSubscriber(userInfo);

        const welcomeMessage =
          `\nWelcome, *${userInfo.first_name}*! ✌️\n\n` +
          `You are now subscribed.\n` +
          `Commands:\n/status\n/stop`;

        bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });

      } else if (text === '/stop') {
        await updateSubscription(chatId, false);
        bot.sendMessage(chatId, "Unsubscribed. Type /start to subscribe again.");

      } else if (text === '/status') {
        bot.sendMessage(chatId, "Fetching latest data...");
        const latestData = await getLatestSensorData();
        const formattedMessage = formatLatestData(latestData);

        bot.sendMessage(chatId, formattedMessage, {
          parse_mode: 'Markdown'
        });

      } else {
        bot.sendMessage(chatId, "Unknown command. Use /start, /stop, or /status.");
      }

    } catch (error) {
      console.error(`Telegram command error from ${chatId}:`, error);
      bot.sendMessage(chatId, "Error processing command.");
    }
  }

  res.sendStatus(200);
});

// ===============================
// DASHBOARD APIs
// ===============================

app.get('/api/data', async (req, res) => {
  try {
    const d = await getLatestSensorData();
    if (!d) return res.status(204).send();
    res.json(d);
  } catch (e) {
    console.error('API /data error:', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ✅ FIXED GRAPH API
app.get('/api/graph-data', async (req, res) => {
  const { type, range } = req.query;

  if (!type || !range) {
    return res.status(400).json({ error: 'Missing params' });
  }

  try {
    const d = await getHistoricalData(type, range);
    if (!d || d.length === 0) return res.status(204).send();
    res.json(d);
  } catch (e) {
    console.error('API /graph-data error:', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ===============================
// THRESHOLDS
// ===============================

app.get('/api/get-thresholds', async (req, res) => {
  try {
    const t =
      Object.keys(ALERT_THRESHOLDS).length > 0
        ? ALERT_THRESHOLDS
        : await getThresholds();

    res.json(t || {});
  } catch (e) {
    console.error('API /get-thresholds error:', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.post('/api/set-thresholds', async (req, res) => {
  const nt = req.body;

  if (!nt || Object.keys(nt).length === 0) {
    return res.status(400).json({ error: 'No thresholds' });
  }

  try {
    const success = await updateThresholds(nt);

    if (success) {
      await loadThresholdsFromDB();
      return res.status(200).json({ message: 'Updated' });
    }

    res.status(500).json({ error: 'DB update failed' });
  } catch (e) {
    console.error('API /set-thresholds error:', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ===============================
// REPORT TIME
// ===============================

app.get('/api/get-report-time', async (req, res) => {
  res.json({ report_times: dailyReportScheduleTimes });
});

app.post('/api/set-report-time', async (req, res) => {
  const { report_times: nt } = req.body;

  if (!Array.isArray(nt) || nt.length === 0) {
    return res.status(400).json({ error: 'Invalid times' });
  }

  try {
    const success = await updateAllReportScheduleTimes(nt);

    if (success) {
      await loadAndScheduleReports();
      return res.status(200).json({ message: 'Updated' });
    }

    res.status(500).json({ error: 'DB update failed' });
  } catch (e) {
    console.error('API /set-report-time error:', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ===============================
// ALERT ENGINE
// ===============================

async function sendAlertToAll(messages) {
  const subs = await getSubscribers();
  const chatIds = subs.map(s => s.chat_id);
  await sendStructuredAlert(chatIds, 'ALERT', messages);
}

function checkThresholdAndState(metricName, stateKey, currentValue) {
  if (!ALERT_THRESHOLDS?.[metricName]) return null;
  if (typeof currentValue !== 'number' || isNaN(currentValue)) return null;
  if (!currentAlertState?.[stateKey]) return null;

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
            alertMsg = `AQI WARNING: ${currentValue.toFixed(0)} PPM (${comp} ${tVal})`;
            break;
          case 'uv':
            alertMsg = `HIGH UV: ${currentValue.toFixed(1)} (${comp} ${tVal})`;
            break;
          case 'bmp_temp':
            alertMsg = `HIGH TEMP: ${currentValue.toFixed(1)}°C (${comp} ${tVal})`;
            break;
          case 'pressure':
            alertMsg = `LOW PRESSURE: ${currentValue.toFixed(1)} hPa (${comp} ${tVal})`;
            break;
          case 'rain_percentage':
            alertMsg = `HEAVY RAIN: ${currentValue.toFixed(0)}% (${comp} ${tVal})`;
            break;
        }
      }
    }
  } else {
    if (state.alarming) {
      state.consecutiveCount++;

      if (state.consecutiveCount >= REQUIRED_CONSECUTIVE_READINGS) {
        state.alarming = false;
        state.consecutiveCount = 0;
      }
    } else {
      state.consecutiveCount = 0;
    }
  }

  return alertMsg;
}

const alertingEngine = {
  checkForAlerts(data) {
    if (Object.keys(ALERT_THRESHOLDS).length === 0) return;

    const msgs = [];

    const checks = [
      ['aqi', 'aqi', data.aqi],
      ['uv', 'uv', data.uv],
      ['bmp_temp', 'bmp_temp', data.bmp_temp],
      ['pressure', 'pressure', data.pressure],
      ['rain_percentage', 'rain', data.rain_percentage]
    ];

    checks.forEach(([metric, key, value]) => {
      const msg = checkThresholdAndState(metric, key, value);
      if (msg) msgs.push(msg);
    });

    if (msgs.length > 0) {
      console.log('--- TRIGGERED ALERTS ---');
      sendAlertToAll(msgs);
    }
  }
};

// ===============================
// REPORT SCHEDULER
// ===============================

async function sendDailyReport() {
  try {
    const subs = await getSubscribers();
    const chatIds = subs.map(s => s.chat_id);
    const data = await getLatestSensorData();

    if (data && chatIds.length > 0) {
      const msgs = [formatLatestData(data)];
      await sendStructuredAlert(chatIds, 'REPORT', msgs);
    }
  } catch (e) {
    console.error("Report error:", e);
  }
}

function scheduleDailyReports(times_hh_mm) {
  dailyReportCronJobs.forEach(j => j.stop());
  dailyReportCronJobs = [];

  dailyReportScheduleTimes = times_hh_mm;

  times_hh_mm.forEach(t => {
    const [h, m] = t.split(':');
    const cronEx = `${m} ${h} * * *`;

    const job = cron.schedule(cronEx, sendDailyReport, {
      scheduled: true,
      timezone: "Asia/Kolkata"
    });

    dailyReportCronJobs.push(job);
  });

  console.log(`Scheduled ${dailyReportCronJobs.length} report(s).`);
}

async function loadAndScheduleReports() {
  const times = await getAllReportScheduleTimes();
  scheduleDailyReports(times);
}

// ===============================
// LOAD THRESHOLDS
// ===============================

async function loadThresholdsFromDB() {
  const tFromDB = await getThresholds();

  if (tFromDB && Object.keys(tFromDB).length > 0) {
    ALERT_THRESHOLDS = tFromDB;
    currentAlertState = {};

    Object.keys(ALERT_THRESHOLDS).forEach(m => {
      const sk = m === 'rain_percentage' ? 'rain' : m;
      currentAlertState[sk] = { alarming: false, consecutiveCount: 0 };
    });
  } else {
    ALERT_THRESHOLDS = {};
    currentAlertState = {};
  }
}

// ===============================
// INIT
// ===============================

async function initializeApp() {
  try {
    await loadThresholdsFromDB();
    await loadAndScheduleReports();
    await startTelegramBot();
    startMqttClient(alertingEngine);

    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (e) {
    console.error("CRITICAL INIT ERROR:", e);
    process.exit(1);
  }
}

initializeApp();
