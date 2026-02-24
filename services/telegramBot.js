// =====================================================
// Telegram Bot Service
// =====================================================

const TelegramBot = require('node-telegram-bot-api');

let bot = null;

function startTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("⚠️ Telegram token missing");
    return;
  }

  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

  const webhookUrl = process.env.RENDER_EXTERNAL_URL;

  if (webhookUrl) {
    bot.setWebHook(`${webhookUrl}/api/telegram-webhook`);
    console.log("✅ Telegram webhook set");
  }
}

function getBotInstance() {
  return bot;
}

function formatStatus(data) {
  if (!data) return "No data available";

  return `
📊 *CampusSense Status*

🌡 Temp: ${data.bmp_temp}°C
💧 Humidity: ${data.humidity}%
🫁 CO₂: ${data.co2_ppm}
☀️ UV: ${data.uv_index}
🌧 Rain: ${data.rain_pcnt}%
💡 Light: ${data.light_pcnt}%
  `;
}

module.exports = {
  startTelegramBot,
  getBotInstance,
  formatStatus
};
