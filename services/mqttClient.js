// services/mqttClient.js

const mqtt = require('mqtt');
const { insertSensorData } = require('./supabaseClient');
require('dotenv').config();

function startMqttClient(alertingEngine) {
  console.log("🔐 Connecting to Secure MQTT Broker...");

  // ===============================
  // MQTT OPTIONS (PRODUCTION SAFE)
  // ===============================
  const options = {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    keepalive: 60,
    reconnectPeriod: 5000, // auto reconnect
    connectTimeout: 30 * 1000,
    clean: true,
  };

  if (!process.env.MQTT_BROKER_URL) {
    console.error("❌ FATAL: MQTT_BROKER_URL not defined!");
    return;
  }

  const client = mqtt.connect(process.env.MQTT_BROKER_URL, options);

  // ===============================
  // CONNECT
  // ===============================
  client.on('connect', () => {
    console.log("✅ MQTT Connected!");

    const topic = process.env.MQTT_TOPIC;

    if (!topic) {
      console.error("❌ FATAL: MQTT_TOPIC not defined!");
      return;
    }

    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        console.error("❌ MQTT Subscribe failed:", err);
      } else {
        console.log(`📡 Subscribed to: ${topic}`);
      }
    });
  });

  // ===============================
  // MESSAGE HANDLER
  // ===============================
  client.on('message', async (topic, payload) => {
    try {
      if (!payload) return;

      let readings;

      // 🔒 Safe JSON parse
      try {
        readings = JSON.parse(payload.toString());
      } catch (parseErr) {
        console.error("❌ Invalid JSON payload:", parseErr);
        return;
      }

      const location = topic.split('/').pop() || "unknown";

      // ===============================
      // NORMALIZE DATA
      // ===============================
      const dataToInsert = {
        location,
        bmp_temp: Number(readings.bmp_temp) || null,
        dht_temp: Number(readings.dht_temp) || null,
        humidity: Number(readings.humidity) || null,
        pressure: Number(readings.pressure) || null,
        aqi: Number(readings.co2_ppm) || null,
        uv: Number(readings.uv_index) || null,
        light_level: Number(readings.light_pcnt) || null,
        rain_percentage: Number(readings.rain_pcnt) || null
      };

      // ===============================
      // INSERT TO DB
      // ===============================
      const success = await insertSensorData(dataToInsert);

      // ===============================
      // ALERT ENGINE
      // ===============================
      if (
        success &&
        alertingEngine &&
        typeof alertingEngine.checkForAlerts === 'function'
      ) {
        alertingEngine.checkForAlerts(dataToInsert);
      }

    } catch (e) {
      console.error('❌ MQTT message processing error:', e);
    }
  });

  // ===============================
  // ERROR HANDLING
  // ===============================
  client.on('reconnect', () => {
    console.log("🔄 MQTT Reconnecting...");
  });

  client.on('close', () => {
    console.warn("⚠️ MQTT connection closed.");
  });

  client.on('offline', () => {
    console.warn("📴 MQTT offline.");
  });

  client.on('error', (e) => {
    console.error("❌ MQTT Error:", e.message);
  });
}

module.exports = { startMqttClient };
