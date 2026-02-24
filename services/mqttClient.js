// =====================================================
// MQTT Client + Threshold Alert Processor
// =====================================================

const mqtt = require('mqtt');
const {
  DEFAULT_USER_ID,
  insertSensorData,
  insertSensorLog,
  processThresholdAlerts
} = require('./supabaseClient');
const { getBotInstance } = require('./telegramBot');

function startMqttClient() {
  console.log('[mqtt] connecting to broker...');

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
      await insertSensorLog({
        userId: DEFAULT_USER_ID,
        temperature: data.bmp_temp,
        humidity: data.humidity,
        pressure: data.pressure
      });

      const alertResult = await processThresholdAlerts({
        userId: DEFAULT_USER_ID,
        sensorData: data
      });

      if (alertResult.triggered) {
        console.log('[alerts] threshold alert sent:', alertResult.message);
        const bot = getBotInstance();
        if (bot && process.env.TELEGRAM_CHAT_ID) {
          await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `CampusSense Alert\n${alertResult.message}`);
        }
      } else {
        console.log('[alerts] no alert sent:', alertResult.reason);
      }
    } catch (err) {
      console.error('[mqtt] message processing failed:', err.message);
    }
  });
}

module.exports = { startMqttClient };
