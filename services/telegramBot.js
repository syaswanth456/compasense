// services/telegramBot.js

const TelegramBot = require('node-telegram-bot-api');
const { getLatestSensorData } = require('./supabaseClient');
require('dotenv').config();

let bot;

// ===============================
// HELPERS
// ===============================

function getBotInstance() {
  return bot;
}

function safeNum(val, digits = 1) {
  return (typeof val === 'number' && !isNaN(val))
    ? val.toFixed(digits)
    : 'N/A';
}

function getRainStatus(p) {
  if (typeof p !== 'number' || isNaN(p)) return "N/A";
  if (p === 0) return "Dry";
  if (p <= 25) return "Light Moisture";
  if (p <= 70) return "Moderate Rain";
  return "Heavy Rain";
}

// ===============================
// FORMAT SENSOR DATA
// ===============================

function formatLatestData(d) {
  if (!d) return "No sensor data available.";

  const rs = getRainStatus(d.rain_percentage);

  const timeStr = new Date(d.created_at).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    timeStyle: 'short',
    dateStyle: 'short'
  });

  return (
`📊 *Latest Status* (${timeStr} IST)

🌡 BMP Temp: ${safeNum(d.bmp_temp)}°C
🌡 DHT Temp: ${safeNum(d.dht_temp)}°C
💧 Humidity: ${safeNum(d.humidity)}%
🫁 AQI: ${safeNum(d.aqi, 0)} PPM
☀️ UV: ${safeNum(d.uv)}
💡 Light: ${safeNum(d.light_level)}%
🌧 Rain: *${rs}*
📉 Pressure: ${safeNum(d.pressure)} hPa
`
  );
}

// ===============================
// SEND ALERT / REPORT
// ===============================

async function sendStructuredAlert(chatIds, type, messages) {
  const botInstance = getBotInstance();
  if (!botInstance || !chatIds?.length) return;

  const title = type === 'ALERT' ? '🚨 ALERT' : '📋 REPORT';

  const baseMsg =
`*${title}*

${messages.join('\n')}
`;

  const footer =
`\n_Time: ${new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata'
  })} IST_`;

  const fullMsg = baseMsg + footer;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📊 Status", callback_data: "/status" }],
      [{ text: "🌐 Dashboard", url: process.env.RENDER_EXTERNAL_URL || '#' }],
      [{ text: "🔕 Stop", callback_data: "/stop" }]
    ]
  };

  for (const cid of chatIds) {
    try {
      await botInstance.sendMessage(cid, fullMsg, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (e) {
      console.error(`❌ Failed send to ${cid}:`, e.message);
    }
  }
}

// ===============================
// BOT COMMANDS
// ===============================

async function setBotCommands(botInstance) {
  const commands = [
    { command: 'start', description: 'Start alerts/reports' },
    { command: 'status', description: 'Get current readings' },
    { command: 'stop', description: 'Stop notifications' }
  ];

  try {
    await botInstance.setMyCommands(commands);
    console.log('✅ Bot commands set');
  } catch (e) {
    console.error('❌ Command setup error:', e.message);
  }
}

// ===============================
// CALLBACK HANDLER
// ===============================

function setupCallbackHandler(botInstance) {
  if (!botInstance) return;

  botInstance.on('callback_query', async (cbq) => {
    try {
      const chatId = cbq.message.chat.id;
      const data = cbq.data;

      await botInstance.answerCallbackQuery(cbq.id);

      if (data === '/status') {
        botInstance.sendMessage(chatId, "Fetching latest...");
        const latest = await getLatestSensorData();
        const msg = formatLatestData(latest);

        botInstance.sendMessage(chatId, msg, {
          parse_mode: 'Markdown'
        });

      } else if (data === '/stop') {
        botInstance.sendMessage(
          chatId,
          "To stop alerts, type */stop*",
          { parse_mode: 'Markdown' }
        );
      }

    } catch (err) {
      console.error("❌ Callback error:", err);
    }
  });
}

// ===============================
// START BOT (WEBHOOK MODE)
// ===============================

function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookUrl = process.env.RENDER_EXTERNAL_URL;

  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set!');
    return;
  }

  if (!webhookUrl) {
    console.error('❌ RENDER_EXTERNAL_URL not set!');
    return;
  }

  console.log('🤖 Starting Telegram Bot (Webhook mode)...');

  const botInstance = new TelegramBot(token);

  botInstance.setWebHook(`${webhookUrl}/api/telegram-webhook`);

  console.log(`✅ Webhook set: ${webhookUrl}/api/telegram-webhook`);

  bot = botInstance;

  setupCallbackHandler(botInstance);
  setBotCommands(botInstance);

  botInstance.on('polling_error', (err) => {
    console.error("❌ Telegram polling error:", err.message);
  });
}

// ===============================
// EXPORTS
// ===============================

module.exports = {
  startTelegramBot,
  getBotInstance,
  formatLatestData,
  sendStructuredAlert
};
