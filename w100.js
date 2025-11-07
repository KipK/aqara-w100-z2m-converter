const {Zcl} = require("zigbee-herdsman");
const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const { logger } = require("zigbee-herdsman-converters/lib/logger");
const lumi = require("zigbee-herdsman-converters/lib/lumi");
const m = require("zigbee-herdsman-converters/lib/modernExtend");

// Minimum interval (in milliseconds) to send a PMTSD frame, even if no value has changed.
const MIN_SEND_INTERVAL_MS = 5000;

const e = exposes.presets;
const ea = exposes.access;

const {
    lumiAction,
    lumiZigbeeOTA,
    lumiExternalSensor,
} = lumi.modernExtend;

const NS = "zhc:lumi";
const manufacturerCode = lumi.manufacturerCode;

const W100_0844_req = {
    cluster: 'manuSpecificLumi',
    type: ['attributeReport', 'readResponse'],
    convert: async (model, msg, publish, options, meta) => {
        const attr = msg.data[65522];
        if (!attr || !Buffer.isBuffer(attr)) return;

        const endsWith = Buffer.from([0x08, 0x00, 0x08, 0x44]);
        if (attr.slice(-4).equals(endsWith)) {
            meta.logger.info(`Aqara W100: PMTSD request detected from device ${meta.device.ieeeAddr}`);
            
            // Function to convert string -> number
            const convertToNumber = (key, value) => {
                if (typeof value !== 'string') return value;
                
                switch(key) {
                    case 'system_mode':
                        const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
                        return modeMap[value.toLowerCase()] ?? 0;
                    case 'fan_mode':
                        const speedMap = { 'auto': 0, 'low': 1, 'medium': 2, 'high': 3 };
                        return speedMap[value.toLowerCase()] ?? 0;
                    case 'unused':
                        return parseInt(value, 10);
                    default:
                        return value;
                }
            };
            
            // Retrieve PMTSD values from meta.state and convert to numbers
            const pmtsdValues = {
                P: meta.state?.system_mode === 'off' ? 1 : 0,
                M: convertToNumber('system_mode', meta.state?.system_mode) ?? 0,
                T: meta.state?.occupied_heating_setpoint ?? 15,
                S: convertToNumber('fan_mode', meta.state?.fan_mode) ?? 0,
                D: convertToNumber('unused', meta.state?.unused) ?? 0
            };
            
            // Send PMTSD frame with stored values
            try {
                await PMTSD_to_W100.convertSet(meta.device.getEndpoint(1), 'PMTSD_to_W100', pmtsdValues, meta);
                meta.logger.info(`Aqara W100: PMTSD frame sent for ${meta.device.ieeeAddr}`);
            } catch (error) {
                meta.logger.error(`Aqara W100: Failed to send PMTSD frame: ${error.message}`);
            }
            
            return { action: 'W100_PMTSD_request' };
        }
    },
};

const PMTSD_to_W100 = {
    key: ['system_mode', 'occupied_heating_setpoint', 'fan_mode', 'unused', 'PMTSD_to_W100'],
    convertSet: async (entity, key, value, meta) => {
        // Logger fallback in case meta.logger is undefined
        const log = meta.logger || logger;
        
        // Extract current P and M from meta.state.system_mode
        let initialP = 0;
        let initialM = 0;
        if (meta.state?.system_mode) {
            if (meta.state.system_mode === 'off') {
                initialP = 1;
                initialM = 0; // Default mode when off
            } else {
                initialP = 0;
                const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
                initialM = modeMap[meta.state.system_mode] ?? 0;
            }
        }
        
        // Extract current S from meta.state.fan_mode
        let initialS = 0;
        if (meta.state?.fan_mode) {
            const speedMap = { 'auto': 0, 'low': 1, 'medium': 2, 'high': 3 };
            initialS = speedMap[meta.state.fan_mode] ?? 0;
        }
        
        // Retrieve current PMTSD values from meta.state
        let pmtsd = {
            P: initialP,
            M: initialM,
            T: meta.state?.occupied_heating_setpoint ?? 15,
            S: initialS,
            D: meta.state?.unused ?? 0
        };

        // Convert text values to numbers for internal storage
        if (typeof pmtsd.T === 'string') {
            pmtsd.T = parseInt(pmtsd.T, 10);
        }
        if (typeof pmtsd.D === 'string') {
            pmtsd.D = parseInt(pmtsd.D, 10);
        }

        let hasChanged = false;
        let newDisplayValue = value;

        if (key === 'PMTSD_to_W100') {
            // Internal call: use value as {P, M, T, S, D} object
            if (value.P !== undefined) pmtsd.P = Number(value.P);
            if (value.M !== undefined) pmtsd.M = Number(value.M);
            if (value.T !== undefined) pmtsd.T = Number(value.T);
            if (value.S !== undefined) pmtsd.S = Number(value.S);
            if (value.D !== undefined) pmtsd.D = Number(value.D);
            hasChanged = true;
        } else {
            // For keys set individually by Home Assistant
            let fieldName, previousValue, numValue;

            // Check if Thermostat_Mode is ON for climate commands
            if (meta.state?.Thermostat_Mode !== 'ON' && ['system_mode', 'occupied_heating_setpoint', 'fan_mode'].includes(key)) {
                log.warning(`Aqara W100: Ignoring ${key} command - Thermostat_Mode is not ON`);
                return { state: {} };
            }

            switch (key) {
                case 'system_mode':
                    previousValue = pmtsd.M;
                    let powerChanged = false;
                    let modeChanged = false;

                    if (value === 'off') {
                        // Set power to off (1)
                        if (pmtsd.P !== 1) {
                            pmtsd.P = 1;
                            powerChanged = true;
                            hasChanged = true;
                        }
                    } else {
                        // Set power to on (0) if not already
                        if (pmtsd.P !== 0) {
                            pmtsd.P = 0;
                            powerChanged = true;
                            hasChanged = true;
                        }
                        // Set mode
                        const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
                        if (typeof value === 'string') {
                            numValue = modeMap[value.toLowerCase()];
                        } else {
                            numValue = Number(value);
                        }
                        if (numValue !== undefined && [0, 1, 2].includes(numValue)) {
                            if (pmtsd.M !== numValue) {
                                pmtsd.M = numValue;
                                modeChanged = true;
                                hasChanged = true;
                            }
                            const modeNames = ['cool', 'heat', 'auto'];
                            newDisplayValue = modeNames[numValue] || value;
                        } else {
                            throw new Error('system_mode must be "off", "cool", "heat", or "auto"');
                        }
                    }
                    hasChanged = powerChanged || modeChanged;
                    break;
                case 'occupied_heating_setpoint':
                    previousValue = pmtsd.T;
                    const temp = parseFloat(value);
                    if (isNaN(temp) || temp < 15 || temp > 30) {
                        throw new Error('occupied_heating_setpoint must be between 15 and 30');
                    }
                    // Round to nearest integer
                    const rounded = Math.round(temp);
                    pmtsd.T = rounded;
                    newDisplayValue = rounded;
                    hasChanged = rounded !== previousValue;
                    break;
                case 'fan_mode':
                    previousValue = pmtsd.S;
                    // Convert string to number: "auto" -> 0, "low" -> 1, "medium" -> 2, "high" -> 3
                    if (typeof value === 'string') {
                        const speedMap = { 'auto': 0, 'low': 1, 'medium': 2, 'high': 3 };
                        numValue = speedMap[value.toLowerCase()];
                        newDisplayValue = value.toLowerCase();
                    } else {
                        numValue = Number(value);
                        const speedNames = ['auto', 'low', 'medium', 'high'];
                        newDisplayValue = speedNames[numValue];
                    }
                    if (![0, 1, 2, 3].includes(numValue)) {
                        throw new Error('fan_mode must be "auto", "low", "medium", or "high"');
                    }
                    pmtsd.S = numValue;
                    hasChanged = numValue !== previousValue;
                    break;
                case 'unused':
                    previousValue = pmtsd.D;
                    numValue = typeof value === 'string' ? parseInt(value, 10) : Number(value);
                    if (![0, 1].includes(numValue)) {
                        throw new Error('unused must be 0 or 1');
                    }
                    pmtsd.D = numValue;
                    newDisplayValue = String(numValue);
                    hasChanged = numValue !== previousValue;
                    break;
                default:
                    throw new Error(`Aqara W100: Unrecognized key: ${key}`);
            }
        }

        // Log update
        log.info(`Aqara W100: Processed ${key}, PMTSD: ${JSON.stringify(pmtsd)}, Changed: ${hasChanged}`);

        // Prepare display values for state update
        const modeDisplay = ['cool', 'heat', 'auto'][pmtsd.M] || 'cool';
        const speedDisplay = ['auto', 'low', 'medium', 'high'][pmtsd.S] || 'auto';

        // Update state with climate entity values
        const stateUpdate = {
            state: {
                occupied_heating_setpoint: pmtsd.T,
                fan_mode: speedDisplay,
                system_mode: pmtsd.P === 1 ? 'off' : modeDisplay,
                unused: String(pmtsd.D)
            }
        };

        // Check if all PMTSD values are defined
        const { P, M, T, S, D } = pmtsd;
        if (P === undefined || M === undefined || T === undefined || S === undefined || D === undefined) {
            log.info(`Aqara W100: PMTSD frame not sent: missing values (P:${P}, M:${M}, T:${T}, S:${S}, D:${D})`);
            return stateUpdate;
        }

        // Get current time and last send time
        const now = Date.now();
        if (!meta.device.meta) {
            meta.device.meta = {};
        }
        const lastSendTime = meta.device.meta.lastPMTSDSend || 0;
        const timeElapsed = now - lastSendTime;

        // Decide if we need to send the frame
        // Send if:
        // 1. A value has actually changed (hasChanged = true)
        // OR
        // 2. The minimum send interval has passed (timeElapsed >= MIN_SEND_INTERVAL_MS)
        const shouldSend = hasChanged || (timeElapsed >= MIN_SEND_INTERVAL_MS);

        // Do not send frame if no value changed AND it's too soon since the last send
        if (!shouldSend) {
            log.info(`Aqara W100: PMTSD frame not sent: no value change and sent ${timeElapsed}ms ago (less than ${MIN_SEND_INTERVAL_MS}ms)`);
            return stateUpdate;
        }

        // Format PMTSD (convert numbers to strings for the protocol)
        const pmtsdStr = `P${P}_M${M}_T${T}_S${S}_D${D}`;
        const pmtsdBytes = Array.from(pmtsdStr).map(c => c.charCodeAt(0));
        const pmtsdLen = pmtsdBytes.length;

        const fixedHeader = [
            0xAA, 0x71, 0x1F, 0x44,
            0x00, 0x00, 0x05, 0x41, 0x1C,
            0x00, 0x00,
            0x54, 0xEF, 0x44, 0x80, 0x71, 0x1A,
            0x08, 0x00, 0x08, 0x44, pmtsdLen,
        ];

        const counter = Math.floor(Math.random() * 256);
        fixedHeader[4] = counter;

        const fullPayload = [...fixedHeader, ...pmtsdBytes];

        const checksum = fullPayload.reduce((sum, b) => sum + b, 0) & 0xFF;
        fixedHeader[5] = checksum;

        // Ensure entity is an Endpoint
        const endpoint = entity.getEndpoint ? entity.getEndpoint(1) : entity;
        if (!endpoint || typeof endpoint.write !== 'function') {
            log.error(`Aqara W100: Invalid endpoint for write: ${JSON.stringify(endpoint)}`);
            throw new Error('Aqara W100: Endpoint does not support write operation');
        }

        await endpoint.write(
            64704,
            { 65522: { value: Buffer.from(fullPayload), type: 65 } },
            { manufacturerCode: 4447, disableDefaultResponse: true },
        );

        log.info(`Aqara W100: PMTSD frame sent: ${pmtsdStr}`);
        
        // Update the last send timestamp after successful write
        meta.device.meta.lastPMTSDSend = now;
        
        return stateUpdate;
    },
    convertGet: async (entity, key, meta) => {
        // Return persisted value from meta.state with proper format
        const stateValue = meta.state?.[key];
        
        // Define default values
        const defaultValues = {
            'occupied_heating_setpoint': 15,
            'fan_mode': 'auto',
            'system_mode': 'cool',
            'unused': '0'
        };
        
        return { [key]: stateValue ?? defaultValues[key] };
    },
};

const PMTSD_from_W100 = {
    cluster: 'manuSpecificLumi',
    type: ['attributeReport', 'readResponse'],
    convert: (model, msg, publish, options, meta) => {
        const data = msg.data[65522];
        if (!data || !Buffer.isBuffer(data)) return;

        const endsWith = Buffer.from([0x08, 0x44]);
        const idx = data.indexOf(endsWith);
        if (idx === -1 || idx + 2 >= data.length) return;

        const payloadLen = data[idx + 2];
        const payloadStart = idx + 3;
        const payloadEnd = payloadStart + payloadLen;

        if (payloadEnd > data.length) return;

        const payloadBytes = data.slice(payloadStart, payloadEnd);
        let payloadAscii;
        try {
            payloadAscii = payloadBytes.toString('ascii');
        } catch {
            return;
        }

        // Log initial state for debugging
        meta.logger.info(`Aqara W100: Initial meta.state: ${JSON.stringify(meta.state)}`);

        const result = {};
        const stateUpdate = { state: {} };
        const partsForCombined = [];
        const pairs = payloadAscii.split('_');
        
        // Initialize P and M from meta.state since device may send partial updates
        // Extract P and M from current system_mode if available
        let initialP = 0;
        let initialM = 0;
        if (meta.state?.system_mode) {
            if (meta.state.system_mode === 'off') {
                initialP = 1;
                // Keep M from previous state or default to 0
                const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
                initialM = 0; // Default to cool when off
            } else {
                initialP = 0;
                const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
                initialM = modeMap[meta.state.system_mode] ?? 0;
            }
        }
        
        const pmtsd = { P: initialP, M: initialM, T: 15, S: 0, D: 0 }; // Initialize from current state
        
        pairs.forEach(p => {
            if (p.length >= 2) {
                const key = p[0].toLowerCase();
                const value = p.slice(1);
                let newKey;
                let stateKey;
                let processedValue = value;
                let displayValue = value;
                
                switch (key) {
                    case 'p':
                        newKey = 'PW';
                        stateKey = null; // Don't map P directly - will be combined with M for system_mode
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1].includes(processedValue)) {
                            meta.logger.warn(`Aqara W100: Invalid P value: ${value}`);
                            return;
                        }
                        pmtsd.P = processedValue;
                        displayValue = processedValue;
                        meta.logger.info(`Aqara W100: Parsed P=${processedValue}`);
                        break;
                    case 'm':
                        newKey = 'MW';
                        stateKey = null; // Don't map M directly - will be combined with P for system_mode
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1, 2].includes(processedValue)) {
                            meta.logger.warn(`Aqara W100: Invalid M value: ${value}`);
                            return;
                        }
                        pmtsd.M = processedValue;
                        displayValue = processedValue;
                        meta.logger.info(`Aqara W100: Parsed M=${processedValue}`);
                        break;
                    case 't':
                        newKey = 'TW';
                        stateKey = 'occupied_heating_setpoint';
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || processedValue < 15 || processedValue > 30) return;
                        pmtsd.T = processedValue;
                        displayValue = processedValue;
                        break;
                    case 's':
                        newKey = 'SW';
                        stateKey = 'fan_mode';
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1, 2, 3].includes(processedValue)) return;
                        pmtsd.S = processedValue;
                        const speedNames = ['auto', 'low', 'medium', 'high'];
                        displayValue = speedNames[processedValue];
                        break;
                    case 'd':
                        newKey = 'DW';
                        stateKey = 'unused';
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1].includes(processedValue)) return;
                        pmtsd.D = processedValue;
                        displayValue = String(processedValue);
                        break;
                    default:
                        newKey = key.toUpperCase() + 'W';
                        stateKey = null;
                }
                
                result[newKey] = value;
                if (stateKey) {
                    stateUpdate.state[stateKey] = displayValue;
                    result[stateKey] = displayValue;
                }
                partsForCombined.push(`${newKey}${value}`);
            }
        });

        // Combine power state and mode to create system_mode for climate entity
        // P and M are always valid (initialized from meta.state or defaults)
        const modeDisplay = ['cool', 'heat', 'auto'][pmtsd.M] || 'cool';
        const systemMode = pmtsd.P === 1 ? 'off' : modeDisplay;
        stateUpdate.state.system_mode = systemMode;
        result.system_mode = systemMode;
        meta.logger.info(`Aqara W100: Computed system_mode=${systemMode} from P=${pmtsd.P}, M=${pmtsd.M}`);

        // Format date and time
        const date = new Date();
        const formattedDate = date.toLocaleString('fr-FR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).replace(/,/, '').replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$2-$1');
        
        const combinedString = partsForCombined.length
            ? `${formattedDate}_${partsForCombined.join('_')}`
            : `${formattedDate}`;

        // Log updated state for debugging
        meta.logger.info(`Aqara W100: PMTSD decoded: ${JSON.stringify(result)} from ${meta.device.ieeeAddr}`);
        meta.logger.info(`Aqara W100: Updated meta.state: ${JSON.stringify({ ...meta.state, ...stateUpdate.state })}`);

        return { 
            ...result,
            PMTSD_from_W100_Data: combinedString,
            ...stateUpdate
        };
    },
};

const Thermostat_Mode = {
    key: ['Thermostat_Mode'],
    convertSet: async (entity, key, value, meta) => {
        // Logger fallback in case meta.logger is undefined
        const log = meta.logger || logger;
        
        const deviceMac = meta.device.ieeeAddr.replace(/^0x/, '').toLowerCase();
        const hubMac = '54ef4480711a';
        function cleanMac(mac, expectedLen) {
            const cleaned = mac.replace(/[:\-]/g, '');
            if (cleaned.length !== expectedLen) {
                throw new Error(`Aqara W100: MAC address must contain ${expectedLen} hexadecimal digits`);
            }
            return cleaned;
        }

        const dev = Buffer.from(cleanMac(deviceMac, 16), 'hex');
        const hub = Buffer.from(cleanMac(hubMac, 12), 'hex');

        // Ensure entity is an Endpoint
        const endpoint = entity.getEndpoint ? entity.getEndpoint(1) : entity;
        if (!endpoint || typeof endpoint.write !== 'function') {
            log.error(`Aqara W100: Invalid endpoint for write: ${JSON.stringify(endpoint)}`);
            throw new Error('Aqara W100: Endpoint does not support write operation');
        }

        let frame;

        if (value === 'ON') {
            const prefix = Buffer.from('aa713244', 'hex');
            const messageAlea = Buffer.from([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]);
            const zigbeeHeader = Buffer.from('02412f6891', 'hex');
            const messageId = Buffer.from([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]);
            const control = Buffer.from([0x18]);
            const payloadMacs = Buffer.concat([dev, Buffer.from('0000', 'hex'), hub]);
            const payloadTail = Buffer.from('08000844150a0109e7a9bae8b083e58a9f000000000001012a40', 'hex');

            frame = Buffer.concat([prefix, messageAlea, zigbeeHeader, messageId, control, payloadMacs, payloadTail]);

            // Log the frame for debugging
            log.info(`Aqara W100: Thermostat_Mode ON frame: ${frame.toString('hex')}`);
            
            await endpoint.write(
                64704,
                { 65522: { value: frame, type: 0x41 } },
                { manufacturerCode: 4447, disableDefaultResponse: true },
            );
        } else {
            const prefix = Buffer.from([
                0xaa, 0x71, 0x1c, 0x44, 0x69, 0x1c,
                0x04, 0x41, 0x19, 0x68, 0x91
            ]);
            const frameId = Buffer.from([Math.floor(Math.random() * 256)]);
            const seq = Buffer.from([Math.floor(Math.random() * 256)]);
            const control = Buffer.from([0x18]);

            frame = Buffer.concat([prefix, frameId, seq, control, dev]);
            if (frame.length < 34) {
                frame = Buffer.concat([frame, Buffer.alloc(34 - frame.length, 0x00)]);
            }

            await endpoint.write(
                64704,
                { 65522: { value: frame, type: 0x41 } },
                { manufacturerCode: 4447, disableDefaultResponse: true },
            );
        }

        log.info(`Aqara W100: Thermostat_Mode set to ${value}`);
        return {state: {Thermostat_Mode: value}};
    },
};

module.exports = {
    zigbeeModel: ["lumi.sensor_ht.agl001"],
    model: "TH-S04D",
    vendor: "Aqara",
    description: "Climate Sensor W100",
    fromZigbee: [W100_0844_req, PMTSD_from_W100],
    toZigbee: [PMTSD_to_W100, Thermostat_Mode],
    configure: async (device, coordinatorEndpoint, logger) => {
        // Initialize default values on first connection
        const endpoint = device.getEndpoint(1);
        
        // Publish initial default values
        return {
            occupied_heating_setpoint: 15,
            fan_mode: 'auto',
            system_mode: 'cool',
            unused: '0',
            Thermostat_Mode: 'OFF'
        };
    },
    exposes: [
        // Thermostat Mode control
        e.binary('Thermostat_Mode', ea.ALL, 'ON', 'OFF')
            .withDescription('ON: Enables thermostat mode, buttons send encrypted payloads, and the middle line is displayed. OFF: Disables thermostat mode, buttons send actions, and the middle line is hidden.'),

        // Climate entity for thermostat control (use when Thermostat_Mode is ON)
        e.climate()
            .withSystemMode(['off', 'heat', 'cool', 'auto'])
            .withFanMode(['auto', 'low', 'medium', 'high'])
            .withSetpoint('occupied_heating_setpoint', 15, 30, 1)
            .withLocalTemperature()
            .withDescription('Climate control (HVAC Mode & Target Temperature): Use when Thermostat_Mode is ON. Set HVAC mode to "off" to turn power off, or "heat"/"cool"/"auto" to turn on and select operating mode. Target temperature range: 15-30°C.'),

        // D - Unused parameter as Select
        // e.enum('unused', ea.ALL, ['0', '1'])
        //     .withDescription('Wind mode: 0 or 1'),

        // Action for PMTSD request
        e.action(['W100_PMTSD_request'])
            .withDescription('PMTSD request sent by the W100 via the 08000844 sequence'),

        // Sensor: Latest PMTSD data received from W100
        e.text('PMTSD_from_W100_Data', ea.STATE)
            .withDescription('Latest PMTSD values sent by the W100 when manually changed, formatted as "YYYY-MM-DD HH:mm:ss_Px_Mx_Tx_Sx_Dx"'),
    ],
    extend: [
        lumiZigbeeOTA(),
        m.temperature(),
        m.humidity(),
        lumiExternalSensor({
            temperature: 'external_temperature', 
            humidity: 'external_humidity',
            battery: 'external_battery'
        }),
        m.deviceEndpoints({endpoints: {plus: 1, center: 2, minus: 3}}),
        lumiAction({
            actionLookup: {hold: 0, single: 1, double: 2, release: 255},
            endpointNames: ["plus", "center", "minus"],
        }),
        m.binary({
            name: "Auto_Hide_Middle_Line",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0173, type: Zcl.DataType.BOOLEAN},
            valueOn: [true, 0],
            valueOff: [false, 1],
            description: "Applies only when thermostat mode is enabled. True: Hides the middle line after 30 seconds of inactivity. False: Always displays the middle line.",
            access: "ALL",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
            reporting: false,
        }),
        m.numeric({
            name: "high_temperature",
            valueMin: 26,
            valueMax: 60,
            valueStep: 0.5,
            scale: 100,
            unit: "°C",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0167, type: Zcl.DataType.INT16},
            description: "High temperature alert",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "low_temperature",
            valueMin: -20,
            valueMax: 20,
            valueStep: 0.5,
            scale: 100,
            unit: "°C",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0166, type: Zcl.DataType.INT16},
            description: "Low temperature alert",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "high_humidity",
            valueMin: 65,
            valueMax: 100,
            valueStep: 1,
            scale: 100,
            unit: "%",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x016e, type: Zcl.DataType.INT16},
            description: "High humidity alert",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "low_humidity",
            valueMin: 0,
            valueMax: 30,
            valueStep: 1,
            scale: 100,
            unit: "%",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x016d, type: Zcl.DataType.INT16},
            description: "Low humidity alert",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.enumLookup({
            name: "sampling",
            lookup: {low: 1, standard: 2, high: 3, custom: 4},
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0170, type: Zcl.DataType.UINT8},
            description: "Temperature and humidity sampling settings",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "period",
            valueMin: 0.5,
            valueMax: 600,
            valueStep: 0.5,
            scale: 1000,
            unit: "sec",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0162, type: Zcl.DataType.UINT32},
            description: "Sampling period",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.enumLookup({
            name: "temp_report_mode",
            lookup: {no: 0, threshold: 1, period: 2, threshold_period: 3},
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0165, type: Zcl.DataType.UINT8},
            description: "Temperature reporting mode",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "temp_period",
            valueMin: 1,
            valueMax: 10,
            valueStep: 1,
            scale: 1000,
            unit: "sec",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0163, type: Zcl.DataType.UINT32},
            description: "Temperature reporting period",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "temp_threshold",
            valueMin: 0.2,
            valueMax: 3,
            valueStep: 0.1,
            scale: 100,
            unit: "°C",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x0164, type: Zcl.DataType.UINT16},
            description: "Temperature reporting threshold",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.enumLookup({
            name: "humi_report_mode",
            lookup: {no: 0, threshold: 1, period: 2, threshold_period: 3},
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x016c, type: Zcl.DataType.UINT8},
            description: "Humidity reporting mode",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "humi_period",
            valueMin: 1,
            valueMax: 10,
            valueStep: 1,
            scale: 1000,
            unit: "sec",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x016a, type: Zcl.DataType.UINT32},
            description: "Humidity reporting period",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.numeric({
            name: "humi_threshold",
            valueMin: 2,
            valueMax: 10,
            valueStep: 0.5,
            scale: 100,
            unit: "%",
            cluster: "manuSpecificLumi",
            attribute: {ID: 0x016b, type: Zcl.DataType.UINT16},
            description: "Humidity reporting threshold",
            entityCategory: "config",
            zigbeeCommandOptions: {manufacturerCode},
        }),
        m.identify(),
    ],
};