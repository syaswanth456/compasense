// =====================================================
// MQTT Client (sensor_data ingest only)
// =====================================================

const mqtt = require('mqtt');
const {
  insertSensorData
} = require('./supabaseClient');

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
      console.log('[mqtt] sensor data saved');
    } catch (err) {
      console.error('[mqtt] message handling failed:', err.message);
    }
  });
}

module.exports = { startMqttClient };
