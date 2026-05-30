//! Copy this file to `config.rs` and fill in your own values.
//!   cp src/config.example.rs src/config.rs
//! `config.rs` is gitignored so your WiFi password / keys stay out of git.

// ---- WiFi ----
pub const WIFI_SSID: &str = "YOUR_WIFI_SSID";
pub const WIFI_PASS: &str = "YOUR_WIFI_PASSWORD";

// ---- Backend ----
// IP/host of the machine running the Python backend, e.g. your PC or a Raspberry Pi.
// Use the LAN IP, NOT 127.0.0.1 (that would mean "the ESP32 itself").
pub const SERVER_URL: &str = "http://192.168.1.50:8000/api/readings";
// Must match GARDEN_API_KEY on the backend. Keep this DIFFERENT from your WiFi password.
pub const API_KEY: &str = "change-me-to-a-long-secret";
// Identifies this device on the dashboard. Give each pot a unique id.
pub const NODE_ID: &str = "pot-1";

// ---- Timing ----
// How long the ESP32 sleeps between readings (seconds).
// 900 = every 15 minutes. Longer = much better battery life. Use 30 only for testing.
pub const SLEEP_SECONDS: u64 = 900;

// ---- Moisture sensor calibration (raw ADC values) ----
// The formula works for ANY sensor: set DRY_RAW to the raw value you read in dry
// air, and WET_RAW to the raw value you read in water.
//
// RESISTIVE sensors (e.g. Funduino, two metal prongs): DRY = LOW raw, WET = HIGH raw.
// CAPACITIVE sensors (coated board):                   DRY = HIGH raw, WET = LOW raw.
pub const MOISTURE_DRY_RAW: u16 = 30;   // probe in dry air  (0% moisture)
pub const MOISTURE_WET_RAW: u16 = 2500; // probe in water    (100% moisture)

// ---- Battery monitoring ----
// false = test WITHOUT the voltage divider wired. true once the divider is wired.
pub const BATTERY_ENABLED: bool = false;

// ---- Battery voltage divider ----
// Two equal resistors (e.g. 100k/100k) give a divider ratio of 2.0.
// measured_battery_v = adc_v * BATTERY_DIVIDER
pub const BATTERY_DIVIDER: f32 = 2.0;
pub const BATTERY_FULL_V: f32 = 4.20;
pub const BATTERY_EMPTY_V: f32 = 3.30;
