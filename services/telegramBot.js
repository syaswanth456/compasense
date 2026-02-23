// =====================================================
// Telegram Bot (Webhook Mode - Production)
// =====================================================

const TelegramBot = require('node-telegram-bot-api');
const { getLatestSensorData } = require('./supabaseClient');

let bot = null;

// =====================================================
// FORMAT STATUS MESSAGE
// =====================================================

function formatStatus(d) {
  if (!d) return "❌ No sensor data available.";

  return `
📊 *CampusSense Status*

🌡 BMP Temp: ${d.bmp_temp ?? 'N/A'} °C
🌡 DHT Temp: ${d.dht_temp ?? 'N/A'} °C
💧 Humidity: ${d.humidity ?? 'N/A'} %
🫁 CO₂: ${d.co2_ppm ?? 'N/A'} ppm
☀️ UV: ${d.uv_index ?? 'N/A'}
💡 Light: ${d.light_pcnt ?? 'N/A'} %
🌧 Rain: ${d.rain_pcnt ?? 'N/A'} %
📉 Pressure: ${d.pressure ?? 'N/A'} hPa
`;
}

// =====================================================
// START TELEGRAM
// =====================================================

function startTelegramBot() {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const baseUrl = process.env.RENDER_EXTERNAL_URL;

    if (!token || !baseUrl) {
      console.warn("⚠️ Telegram ENV missing — bot disabled");
      return;
    }

    console.log("🤖 Starting Telegram bot...");

    bot = new TelegramBot(token);

    const webhookUrl = `${baseUrl}/api/telegram-webhook`;

    bot.setWebHook(webhookUrl);

    console.log("✅ Telegram webhook set:", webhookUrl);

  } catch (err) {
    console.error("❌ Telegram init error:", err.message);
  }
}

// =====================================================
// GET BOT INSTANCE
// =====================================================

function getBotInstance() {
  return bot;
}

module.exports = {
  startTelegramBot,
  getBotInstance,
  formatStatus
};
