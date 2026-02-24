// =====================================================
// MQTT Client (Smart Alerts)
// =====================================================

const mqtt = require('mqtt');
const {
  insertSensorData,
  insertWebNotification
} = require('./supabaseClient');

const { getBotInstance } = require('./telegramBot');

let lastAlertTime = 0;

function startMqttClient() {
  console.log("📡 Connecting MQTT...");

  const client = mqtt.connect(process.env.MQTT_BROKER_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
  });

  client.on('connect', () => {
    console.log("✅ MQTT connected");
    client.subscribe(process.env.MQTT_TOPIC);
  });

  client.on('message', async (topic, payload) => {
    try {
      console.log("📨 MQTT message received");

      const r = JSON.parse(payload.toString());

      const data = {
        bmp_temp: r.bmp_temp,
        dht_temp: r.dht_temp,
        humidity: r.humidity,
        pressure: r.pressure,
        co2_ppm: r.co2_ppm,
        uv_index: r.uv_index,
        light_pcnt: r.light_pcnt,
        rain_pcnt: r.rain_pcnt
      };

      await insertSensorData(data);

      // 🚨 anti-spam (30 sec minimum)
      const now = Date.now();
      if (now - lastAlertTime < 30000) return;

      if (data.co2_ppm > 2000) {
        lastAlertTime = now;

        await insertWebNotification(
          "⚠️ High CO₂",
          `CO₂ reached ${data.co2_ppm}`,
          "alert"
        );

        const bot = getBotInstance();
        if (bot && process.env.TELEGRAM_CHAT_ID) {
          await bot.sendMessage(
            process.env.TELEGRAM_CHAT_ID,
            `⚠️ High CO₂: ${data.co2_ppm}`
          );
        }
      }

    } catch (err) {
      console.error("❌ MQTT error:", err.message);
    }
  });
}

module.exports = { startMqttClient };
