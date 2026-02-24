// =====================================================
// MQTT Client (sensor_data + notifications alert flow)
// =====================================================

const mqtt = require('mqtt');
const {
  insertSensorData,
  processThresholdAlerts,
  getActiveTelegramSubscribers
} = require('./supabaseClient');
const { getBotInstance } = require('./telegramBot');

function startMqttClient() {
  console.log('[mqtt] connecting...');

  const client = mqtt.connect(process.env.MQTT_BROKER_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
  });

  client.on('connect', () => {
    console.log('[mqtt] connected');
    client.subscribe(process.env.MQTT_TOPIC);
  });

  client.on('message', async (_topic, payload) => {
    try {
      const r = JSON.parse(payload.toString());
      const data = {
        bmp_temp: Number(r.bmp_temp),
        dht_temp: Number(r.dht_temp),
        humidity: Number(r.humidity),
        pressure: Number(r.pressure),
        co2_ppm: Number(r.co2_ppm),
        uv_index: Number(r.uv_index),
        light_pcnt: Number(r.light_pcnt),
        rain_pcnt: Number(r.rain_pcnt)
      };

      await insertSensorData(data);

      const alertResult = await processThresholdAlerts({ sensorData: data });
      if (alertResult.triggered) {
        console.log('[alerts] sent:', alertResult.message);
        const bot = getBotInstance();
        if (bot) {
          const subscribers = await getActiveTelegramSubscribers();
          if (subscribers.length > 0) {
            for (const chatId of subscribers) {
              try {
                await bot.sendMessage(chatId, `CampusSense Alert\n${alertResult.message}`);
              } catch (sendErr) {
                console.warn(`[telegram] send failed for chat ${chatId}:`, sendErr.message);
              }
            }
          } else if (process.env.TELEGRAM_CHAT_ID) {
            // Backward-compatible fallback for single-recipient mode.
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `CampusSense Alert\n${alertResult.message}`);
          }
        }
      } else {
        console.log('[alerts] skipped:', alertResult.reason);
      }
    } catch (err) {
      console.error('[mqtt] message handling failed:', err.message);
    }
  });
}

module.exports = { startMqttClient };
