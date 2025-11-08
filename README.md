# Aqara W100 External Converter for Zigbee2MQTT + Home Assistant Blueprint

This project provides:

- A dedicated Zigbee2MQTT external converter for the Aqara W100 Climate Sensor.
- A Home Assistant blueprint for seamless, bidirectional sync between the W100's virtual thermostat and any climate entity.

It turns the W100 into a reliable, flexible front-end for your heating/cooling system while preserving its native behavior and making it play nicely with your existing Home Assistant setup.

---

## Key Features

### 1. Robust initialization after pairing

The included converter ensures a clean, deterministic state as soon as the W100 is paired:

- Correct initialization of:
  - `Thermostat_Mode` (starts as `OFF` to match device behavior)
  - `system_mode`
  - `occupied_heating_setpoint`
  - `fan_mode`
  - internal defaults and metadata
- Prevents `null`/inconsistent values in Zigbee2MQTT.
- Keeps the device out of unintended thermostat mode on first join (and explicitly enforces `OFF` once during configuration).

All of this is implemented directly in [`w100.js`](w100.js).

---

### 2. Virtual climate entity exposure

The converter exposes a full-featured virtual climate entity in Zigbee2MQTT for the W100:

- `system_mode`: `off`, `heat`, `cool`, `auto`
- `fan_mode`: `auto`, `low`, `medium`, `high`
- `occupied_heating_setpoint`: configurable range (see below), 1°C step
- `local_temperature`: kept in sync, based on the W100's internal temperature reports
- `Thermostat_Mode`:
  - `ON`: W100 behaves as a thermostat front-end (encrypted button payloads, middle line enabled).
  - `OFF`: W100 behaves as a remote/sensor (actions exposed, thermostat behavior disabled).

This creates a stable "virtual thermostat" entity that can be mapped to any actual heating/cooling device in Home Assistant.

---

### 3. System and fan mode control

The converter handles and normalizes all key HVAC parameters:

- System mode:
  - `off`: power off state (with last active mode preserved)
  - `heat`
  - `cool`
  - `auto`
- Fan mode:
  - `auto`
  - `low`
  - `medium`
  - `high`

Changes are converted into the Aqara-specific PMTSD protocol frames and sent to the W100 with:

- Debounced / rate-limited sending
- Stateful handling of last active mode when toggling `off`/`on`
- Consistent state updates exposed back to Zigbee2MQTT

---

### 4. Temperature setpoint handling and per-device range

- Exposes `occupied_heating_setpoint` as the target temperature.
- Supports a **per-device configurable target range** via Zigbee2MQTT device settings:
  - Navigate to your W100 device → **Settings** → **Device specific**
  - Configure:
    - **Min Target Temp**: Minimum allowed temperature (default: 5°C, range: -20°C to 60°C, step: 0.5°C)
    - **Max Target Temp**: Maximum allowed temperature (default: 30°C, range: -20°C to 60°C, step: 0.5°C)
  - These values **persist across restarts** and are specific to each W100 device
- **Default range** (if not configured): 5°C to 30°C
- **Enforcement**:
  - The climate entity's temperature range in MQTT discovery uses your configured values
  - Setting temperature outside the configured range is rejected with a clear error message
  - Validation occurs in [`PMTSD_to_W100.convertSet()`](w100.js:311) using `meta.options`
- **Dynamic behavior**:
  - The [`exposes` function](w100.js:904) reads configured values from device-specific options
  - The climate entity's [`withSetpoint()`](w100.js:920) uses these configured values for min/max
  - Changes to min/max settings require a Z2M restart to update the MQTT discovery configuration
- Temperature values are rounded to integer °C for the device, while allowing half-degree configuration precision
- Always kept in sync with the underlying PMTSD state to avoid desync between UI and device

---

### 5. Battery voltage and percentage

The W100 does not use standard `batteryVoltage` reporting. The converter:

- Parses Aqara's proprietary TLV data (manuSpecificLumi, attribute `0x247`).
- Extracts:
  - `battery_voltage` (V)
  - `battery` (%), derived from voltage.
- Also configures standard `genPowerCfg.batteryPercentageRemaining` reporting when available.


---

### 6. Additional exposes and options

The converter also exposes:

- Internal temperature: `temperature` / `local_temperature`.
- `PMTSD_from_W100_Data`: last raw PMTSD frame decoded (for debugging/advanced usage).
- OTA support via `lumiZigbeeOTA`.
- External sensor mapping (temperature/humidity).
- Multiple configuration options via `modernExtend`:
  - Auto hide middle line when in thermostat mode.
  - High/low temperature and humidity alerts.
  - Sampling and reporting modes and periods.
  - Identify and other quality-of-life settings.

See [`w100.js`](w100.js) for the full list of exposed entities and options.

---

## Home Assistant Blueprint

A dedicated blueprint is included to link the W100 virtual thermostat to any climate entity.

Goal:

- Bidirectional synchronization between:
  - The W100 virtual thermostat entity (from this converter)
  - Any existing Home Assistant `climate` entity (heat pump, boiler thermostat, relay, etc.)

Behavior:

- Changes made on the W100 (mode, setpoint, fan) are propagated to the target climate entity.
- Changes made in Home Assistant (in the linked climate entity) are reflected back to the W100.
- Keeps UI/behavior consistent, so users can control their real HVAC system directly from the W100 with instant feedback.

Blueprint file:

- [`w100-blueprint.yaml`](w100-blueprint.yaml)

---

## Installation

### 1. Zigbee2MQTT external converter

1. Copy [`w100.js`](w100.js) into your Zigbee2MQTT external converters directory, e.g.:

   - `/config/zigbee2mqtt/w100.js`
   - or `/opt/zigbee2mqtt/data/w100.js`
   (path may vary depending on your setup)

2. In your Zigbee2MQTT `configuration.yaml`, add:

   ```yaml
   external_converters:
     - w100.js
   ```

3. Restart Zigbee2MQTT.

4. Pair the Aqara W100:
   - Put Zigbee2MQTT in pairing mode.
   - Reset/pair the W100 as usual.
   - After join, the device should appear as `Aqara TH-S04D` / "Climate Sensor W100" with the new exposes.

---

### 2. Home Assistant blueprint

1. In Home Assistant, import the blueprint using `w100-blueprint.yaml`:

   - Go to "Settings" → "Automations & Scenes" → "Blueprints" → "Import Blueprint".
   - Upload the file or host it in a repo/raw URL and paste the link.

2. Create a new automation from this blueprint:
   - Select the W100 climate entity (exposed by Zigbee2MQTT with this converter).
   - Select the target `climate` entity you want to control (heat pump, thermostat, etc.).

3. Save and enable.

From now on, the W100 and the target climate entity remain synchronized in both directions.

---

## Why this project?

The stock behavior of the Aqara W100 with generic integrations is limited:

- Incomplete or unstable thermostat representation.
- Non-standard battery reporting.
- Lack of robust bidirectional sync with real HVAC devices.

This project focuses on:

- Correct protocol handling for the W100.
- Clean integration with Zigbee2MQTT.
- First-class Home Assistant UX through a proper climate entity and ready-to-use blueprint.
- Safety and predictability by:
  - Enforcing deterministic defaults.
  - Avoiding unwanted thermostat activation.
  - Respecting user-selected modes and last active configuration.

If you are using the Aqara W100 as a wall-mounted thermostat display/controller in a Home Assistant environment, this converter + blueprint combo is designed for you.

---

## Disclaimer

- This is a community-driven integration, not an official Aqara product.
- Use at your own risk.
- Review the code in [`w100.js`](w100.js) and the blueprint before deploying in critical environments.
