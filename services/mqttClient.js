// =====================================================
// MQTT Client (HiveMQ Cloud - Production)
// =====================================================

const mqtt = require('mqtt');
const {
  insertSensorData,
  insertWebNotification
} = require('./supabaseClient');

let client = null;

function startMqttClient() {
  try {
    const brokerUrl = process.env.MQTT_BROKER_URL;
    const username = process.env.MQTT_USERNAME;
    const password = process.env.MQTT_PASSWORD;
    const topic = process.env.MQTT_TOPIC || '#';

    if (!brokerUrl) {
      console.warn("⚠️ MQTT URL missing — MQTT disabled");
      return;
    }

    console.log("📡 Connecting to MQTT broker...");

    client = mqtt.connect(brokerUrl, {
      username,
      password,
      reconnectPeriod: 5000,
      connectTimeout: 30 * 1000,
      clean: true
    });

    // ===============================
    // CONNECT
    // ===============================
    client.on('connect', () => {
      console.log("✅ MQTT Connected");

      client.subscribe(topic, err => {
        if (err) {
          console.error("❌ MQTT subscribe error:", err.message);
        } else {
          console.log("📡 Subscribed to:", topic);
        }
      });
    });

    // ===============================
    // MESSAGE
    // ===============================
    client.on('message', async (topic, payload) => {
      try {
        const raw = payload.toString();
        console.log("📨 MQTT message received");

        const r = JSON.parse(raw);

        // 🔥 Map ESP → DB
        const dataToInsert = {
          bmp_temp: r.bmp_temp ?? null,
          dht_temp: r.dht_temp ?? null,
          humidity: r.humidity ?? null,
          pressure: r.pressure ?? null,
          co2_ppm: r.co2_ppm ?? null,
          uv_index: r.uv_index ?? null,
          light_pcnt: r.light_pcnt ?? null,
          rain_pcnt: r.rain_pcnt ?? null
        };

        const ok = await insertSensorData(dataToInsert);

        // 🔔 Create web notification on success
        if (ok) {
          await insertWebNotification(
            "New Sensor Reading",
            "Fresh environmental data received",
            "info"
          );
        }

      } catch (err) {
        console.error("❌ MQTT message error:", err.message);
      }
    });

    // ===============================
    // ERROR HANDLING
    // ===============================
    client.on('error', err => {
      console.error("❌ MQTT error:", err.message);
    });

    client.on('close', () => {
      console.warn("⚠️ MQTT connection closed — retrying...");
    });

  } catch (err) {
    console.error("❌ MQTT start failed:", err.message);
  }
}

module.exports = { startMqttClient };
