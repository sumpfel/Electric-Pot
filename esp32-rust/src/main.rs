//! Garden Survailor — ESP32-C3 node firmware (Rust, esp-idf-svc / std).
//!
//! On each wake-up it:
//!   1. reads the capacitive soil-moisture sensor (ADC),
//!   2. reads the LiPo battery voltage (ADC through a divider),
//!   3. connects to WiFi,
//!   4. POSTs a JSON reading to the Python backend,
//!   5. goes into deep sleep for `SLEEP_SECONDS` to save battery.
//!
//! Wiring (see README) — GPIOs chosen for the ESP32-C3 (Seeed XIAO / DevKit):
//!   * Moisture sensor signal -> GPIO2  (ADC1 channel 2)
//!   * Battery divider midpoint -> GPIO3 (ADC1 channel 3)
//!   * Moisture sensor VCC      -> 3V3 (or a GPIO if you want to power it only while reading)

mod config;

use esp_idf_svc::hal::adc::attenuation::DB_11;
use esp_idf_svc::hal::adc::oneshot::config::{AdcChannelConfig, Calibration};
use esp_idf_svc::hal::adc::oneshot::{AdcChannelDriver, AdcDriver};
use esp_idf_svc::hal::delay::FreeRtos;
use esp_idf_svc::hal::peripherals::Peripherals;
use esp_idf_svc::http::client::{Configuration as HttpConfig, EspHttpConnection};
use esp_idf_svc::eventloop::EspSystemEventLoop;
use esp_idf_svc::nvs::EspDefaultNvsPartition;
use esp_idf_svc::sys::esp_deep_sleep;
use esp_idf_svc::wifi::{AuthMethod, BlockingWifi, ClientConfiguration, Configuration, EspWifi};
use embedded_svc::http::client::Client as HttpClient;
use embedded_svc::http::Method;
use log::{error, info, warn};

const NUM_SAMPLES: usize = 16;

fn main() -> anyhow::Result<()> {
    // Required one-time setup for esp-idf-svc.
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();

    info!("Garden Survailor node '{}' waking up", config::NODE_ID);

    let peripherals = Peripherals::take()?;
    let sysloop = EspSystemEventLoop::take()?;
    let nvs = EspDefaultNvsPartition::take()?;

    // ---- ADC setup (ADC1) ----
    let adc = AdcDriver::new(peripherals.adc1)?;
    let adc_cfg = AdcChannelConfig {
        attenuation: DB_11, // full-scale ~0..3.1V
        // Curve calibration gives accurate millivolt readings on the ESP32-C3.
        calibration: Calibration::Curve,
        ..Default::default()
    };
    // GPIO2 = moisture (always). GPIO3 = battery (only if enabled + wired).
    let mut moisture_pin =
        AdcChannelDriver::new(&adc, peripherals.pins.gpio2, &adc_cfg)?;

    let moisture_raw = read_avg(&adc, &mut moisture_pin)?;
    let moisture_pct = raw_to_moisture(moisture_raw);

    // Battery is optional so you can test before wiring the voltage divider.
    let battery: Option<(f32, f32)> = if config::BATTERY_ENABLED {
        let mut battery_pin =
            AdcChannelDriver::new(&adc, peripherals.pins.gpio3, &adc_cfg)?;
        let battery_mv_at_pin = read_avg(&adc, &mut battery_pin)?;
        let battery_v = (battery_mv_at_pin as f32 / 1000.0) * config::BATTERY_DIVIDER;
        let battery_pct = battery_to_percent(battery_v);
        Some((battery_v, battery_pct))
    } else {
        None
    };

    match battery {
        Some((v, pct)) => info!(
            "moisture: {moisture_pct:.1}% (raw {moisture_raw}) | battery: {v:.2}V ({pct:.0}%)"
        ),
        None => info!(
            "moisture: {moisture_pct:.1}% (raw {moisture_raw}) | battery: disabled"
        ),
    }

    // ---- WiFi + upload (best-effort; we still sleep even if it fails) ----
    match connect_and_send(
        peripherals.modem,
        sysloop,
        nvs,
        moisture_pct,
        moisture_raw,
        battery,
    ) {
        Ok(()) => info!("reading uploaded ✓"),
        Err(e) => error!("upload failed: {e:?}"),
    }

    // ---- Deep sleep ----
    // esp_deep_sleep never returns: the chip powers down and cold-boots into
    // main() again after the timer expires.
    info!("sleeping for {}s", config::SLEEP_SECONDS);
    FreeRtos::delay_ms(100); // let logs flush
    unsafe {
        esp_deep_sleep(config::SLEEP_SECONDS * 1_000_000); // microseconds
    }
}

/// Average several ADC samples in millivolts to smooth out noise.
fn read_avg<'d, T, M>(
    adc: &AdcDriver<'d, T::Adc>,
    chan: &mut AdcChannelDriver<'d, T, M>,
) -> anyhow::Result<u16>
where
    T: esp_idf_svc::hal::gpio::ADCPin,
    M: std::borrow::Borrow<AdcDriver<'d, T::Adc>>,
{
    let mut sum: u32 = 0;
    for _ in 0..NUM_SAMPLES {
        sum += adc.read(chan)? as u32;
        FreeRtos::delay_ms(5);
    }
    Ok((sum / NUM_SAMPLES as u32) as u16)
}

/// Map a raw ADC reading to a 0..100 moisture percentage.
/// Capacitive sensors read HIGH when dry and LOW when wet, so we invert.
fn raw_to_moisture(raw: u16) -> f32 {
    let dry = config::MOISTURE_DRY_RAW as f32;
    let wet = config::MOISTURE_WET_RAW as f32;
    let pct = (dry - raw as f32) / (dry - wet) * 100.0;
    pct.clamp(0.0, 100.0)
}

/// Rough battery percentage from voltage (linear between empty and full).
fn battery_to_percent(v: f32) -> f32 {
    let pct = (v - config::BATTERY_EMPTY_V) / (config::BATTERY_FULL_V - config::BATTERY_EMPTY_V)
        * 100.0;
    pct.clamp(0.0, 100.0)
}

fn connect_and_send(
    modem: esp_idf_svc::hal::modem::Modem,
    sysloop: EspSystemEventLoop,
    nvs: EspDefaultNvsPartition,
    moisture_pct: f32,
    moisture_raw: u16,
    battery: Option<(f32, f32)>,
) -> anyhow::Result<()> {
    let mut wifi = BlockingWifi::wrap(
        EspWifi::new(modem, sysloop.clone(), Some(nvs))?,
        sysloop,
    )?;

    let auth = if config::WIFI_PASS.is_empty() {
        AuthMethod::None
    } else {
        AuthMethod::WPA2Personal
    };

    wifi.set_configuration(&Configuration::Client(ClientConfiguration {
        ssid: config::WIFI_SSID
            .try_into()
            .map_err(|_| anyhow::anyhow!("SSID too long"))?,
        password: config::WIFI_PASS
            .try_into()
            .map_err(|_| anyhow::anyhow!("password too long"))?,
        auth_method: auth,
        ..Default::default()
    }))?;

    wifi.start()?;
    info!("connecting to WiFi '{}'", config::WIFI_SSID);
    wifi.connect()?;
    wifi.wait_netif_up()?;
    let ip = wifi.wifi().sta_netif().get_ip_info()?;
    info!("WiFi connected, IP: {}", ip.ip);

    // Build the JSON payload by hand (no serde needed -> smaller binary).
    // Battery fields are only included when battery monitoring is enabled.
    let battery_json = match battery {
        Some((v, pct)) => format!(
            ",\"battery_voltage\":{v:.3},\"battery_percent\":{pct:.1}"
        ),
        None => String::new(),
    };
    let body = format!(
        "{{\"node_id\":\"{}\",\"moisture\":{:.1},\"moisture_raw\":{}{}}}",
        config::NODE_ID, moisture_pct, moisture_raw, battery_json
    );

    send_post(&body)?;

    // Be polite: disconnect before sleeping.
    let _ = wifi.disconnect();
    Ok(())
}

fn send_post(body: &str) -> anyhow::Result<()> {
    let conn = EspHttpConnection::new(&HttpConfig {
        // If you later switch the backend to HTTPS, set this and enable the
        // crt_bundle in sdkconfig. For local HTTP this is fine.
        use_global_ca_store: false,
        ..Default::default()
    })?;
    let mut client = HttpClient::wrap(conn);

    let len = body.len().to_string();
    let headers = [
        ("Content-Type", "application/json"),
        ("Content-Length", len.as_str()),
        ("X-API-Key", config::API_KEY),
    ];

    let mut req = client.request(Method::Post, config::SERVER_URL, &headers)?;
    req.write_all(body.as_bytes())?;
    req.flush()?;
    let resp = req.submit()?;
    let status = resp.status();
    info!("server responded {}", status);
    if !(200..300).contains(&status) {
        warn!("non-2xx status from server: {}", status);
    }
    Ok(())
}

// `write_all`/`flush` come from this trait.
use embedded_svc::io::Write;
