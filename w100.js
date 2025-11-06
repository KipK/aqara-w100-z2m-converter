const {Zcl} = require("zigbee-herdsman");
const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const { logger } = require("zigbee-herdsman-converters/lib/logger");
const lumi = require("zigbee-herdsman-converters/lib/lumi");
const m = require("zigbee-herdsman-converters/lib/modernExtend");

// --- START OF CONFIGURABLE PARAMETERS ---
// Minimum interval (in milliseconds) to send a PMTSD frame, even if no value has changed.
const MIN_SEND_INTERVAL_MS = 5000;
// --- END OF CONFIGURABLE PARAMETERS ---

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
            
            // Fonction de conversion string -> number
            const convertToNumber = (key, value) => {
                if (typeof value !== 'string') return value;
                
                switch(key) {
                    case 'power':
                        return value.toLowerCase() === 'on' ? 0 : 1;
                    case 'hvac_mode':
                        const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
                        return modeMap[value.toLowerCase()] ?? 0;
                    case 'vent_speed':
                        const speedMap = { 'auto': 0, 'low': 1, 'middle': 2, 'high': 3 };
                        return speedMap[value.toLowerCase()] ?? 0;
                    case 'unused':
                        return parseInt(value, 10);
                    default:
                        return value;
                }
            };
            
            // Retrieve PMTSD values from meta.state and convert to numbers
            const pmtsdValues = {
                P: convertToNumber('power', meta.state?.power) ?? 0,
                M: convertToNumber('hvac_mode', meta.state?.hvac_mode) ?? 0,
                T: meta.state?.target_temperature ?? 15.0,
                S: convertToNumber('vent_speed', meta.state?.vent_speed) ?? 0,
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
    key: ['power', 'hvac_mode', 'target_temperature', 'vent_speed', 'unused', 'PMTSD_to_W100'], // MODIFIÉ: mode -> hvac_mode
    convertSet: async (entity, key, value, meta) => {
        // Retrieve current PMTSD values from meta.state with defaults
        let pmtsd = {
            P: meta.state?.power ?? 0,
            M: meta.state?.hvac_mode ?? 0, // MODIFIÉ: mode -> hvac_mode
            T: meta.state?.target_temperature ?? 15.0,
            S: meta.state?.vent_speed ?? 0,
            D: meta.state?.unused ?? 0
        };

        // Convert text values to numbers for internal storage
        if (typeof pmtsd.P === 'string') {
            pmtsd.P = pmtsd.P === 'on' ? 0 : 1;
        }
        if (typeof pmtsd.M === 'string') {
            const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
            pmtsd.M = modeMap[pmtsd.M] ?? 0;
        }
        if (typeof pmtsd.S === 'string') {
            const speedMap = { 'auto': 0, 'low': 1, 'middle': 2, 'high': 3 };
            pmtsd.S = speedMap[pmtsd.S] ?? 0;
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

            switch (key) {
                case 'power':
                    fieldName = 'P';
                    previousValue = pmtsd.P;
                    // Convert string to number: "on" -> 0, "off" -> 1
                    if (typeof value === 'string') {
                        numValue = value.toLowerCase() === 'on' ? 0 : 1;
                        newDisplayValue = value.toLowerCase();
                    } else {
                        numValue = Number(value);
                        newDisplayValue = numValue === 0 ? 'on' : 'off';
                    }
                    if (![0, 1].includes(numValue)) {
                        throw new Error('power must be "on" (0) or "off" (1)');
                    }
                    pmtsd.P = numValue;
                    hasChanged = numValue !== previousValue;
                    break;
                case 'hvac_mode': // MODIFIÉ: mode -> hvac_mode
                    fieldName = 'M';
                    previousValue = pmtsd.M;
                    // Convert string to number: "cool" -> 0, "heat" -> 1, "auto" -> 2
                    if (typeof value === 'string') {
                        const modeMap = { 'cool': 0, 'heat': 1, 'auto': 2 };
                        numValue = modeMap[value.toLowerCase()];
                        newDisplayValue = value.toLowerCase();
                    } else {
                        numValue = Number(value);
                        const modeNames = ['cool', 'heat', 'auto'];
                        newDisplayValue = modeNames[numValue];
                    }
                    if (![0, 1, 2].includes(numValue)) {
                        throw new Error('hvac_mode must be "cool" (0), "heat" (1), or "auto" (2)');
                    }
                    pmtsd.M = numValue;
                    hasChanged = numValue !== previousValue;
                    break;
                case 'target_temperature':
                    fieldName = 'T';
                    previousValue = pmtsd.T;
                    const temp = parseFloat(value);
                    if (isNaN(temp) || temp < 15.0 || temp > 30.0) {
                        throw new Error('temperature must be between 15.0 and 30.0');
                    }
                    // Round to 1 decimal place
                    const rounded = Math.round(temp * 10) / 10;
                    pmtsd.T = rounded;
                    newDisplayValue = rounded;
                    hasChanged = rounded !== previousValue;
                    break;
                case 'vent_speed':
                    fieldName = 'S';
                    previousValue = pmtsd.S;
                    // Convert string to number: "auto" -> 0, "low" -> 1, "middle" -> 2, "high" -> 3
                    if (typeof value === 'string') {
                        const speedMap = { 'auto': 0, 'low': 1, 'middle': 2, 'high': 3 };
                        numValue = speedMap[value.toLowerCase()];
                        newDisplayValue = value.toLowerCase();
                    } else {
                        numValue = Number(value);
                        const speedNames = ['auto', 'low', 'middle', 'high'];
                        newDisplayValue = speedNames[numValue];
                    }
                    if (![0, 1, 2, 3].includes(numValue)) {
                        throw new Error('vent_speed must be "auto" (0), "low" (1), "middle" (2), or "high" (3)');
                    }
                    pmtsd.S = numValue;
                    hasChanged = numValue !== previousValue;
                    break;
                case 'unused':
                    fieldName = 'D';
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
        logger.info(`Aqara W100: Processed ${key}, PMTSD: ${JSON.stringify(pmtsd)}, Changed: ${hasChanged}`);

        // Prepare display values for state update
        const powerDisplay = pmtsd.P === 0 ? 'on' : 'off';
        const modeDisplay = ['cool', 'heat', 'auto'][pmtsd.M] || 'cool';
        const speedDisplay = ['auto', 'low', 'middle', 'high'][pmtsd.S] || 'auto';

        // Update state with display values (strings for selects, number for temperature)
        const stateUpdate = {
            state: {
                power: powerDisplay,
                hvac_mode: modeDisplay, // MODIFIÉ: mode -> hvac_mode
                target_temperature: pmtsd.T,
                vent_speed: speedDisplay,
                unused: String(pmtsd.D)
            }
        };

        // Check if all PMTSD values are defined
        const { P, M, T, S, D } = pmtsd;
        if (P === undefined || M === undefined || T === undefined || S === undefined || D === undefined) {
            logger.info(`Aqara W100: PMTSD frame not sent: missing values (P:${P}, M:${M}, T:${T}, S:${S}, D:${D})`);
            return stateUpdate;
        }

        // --- MODIFICATION START ---
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
            logger.info(`Aqara W100: PMTSD frame not sent: no value change and sent ${timeElapsed}ms ago (less than ${MIN_SEND_INTERVAL_MS}ms)`);
            return stateUpdate;
        }
        // If we are here, we are sending.
        // We will update meta.device.meta.lastPMTSDSend = now; *after* the successful write.
        // --- MODIFICATION END ---

        // Format matric (convert numbers to strings for the protocol)
        const pmtsdStr = `P${P}_M${M}_T${T.toFixed(1)}_S${S}_D${D}`;
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
            logger.error(`Aqara W100: Invalid endpoint for write: ${JSON.stringify(endpoint)}`);
            throw new Error('Aqara W100: Endpoint does not support write operation');
        }

        await endpoint.write(
            64704,
            { 65522: { value: Buffer.from(fullPayload), type: 65 } },
            { manufacturerCode: 4447, disableDefaultResponse: true },
        );

        logger.info(`Aqara W100: PMTSD frame sent: ${pmtsdStr}`);
        
        // --- MODIFICATION START ---
        // Update the last send timestamp after successful write
        meta.device.meta.lastPMTSDSend = now;
        // --- MODIFICATION END ---
        
        return stateUpdate;
    },
    convertGet: async (entity, key, meta) => {
        // Return persisted value from meta.state with proper format
        const stateValue = meta.state?.[key];
        
        // Define default values
        const defaultValues = {
            'power': 'on',
            'hvac_mode': 'cool', // MODIFIÉ: mode -> hvac_mode
            'target_temperature': 15.0,
            'vent_speed': 'auto',
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
                        stateKey = 'power';
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1].includes(processedValue)) return;
                        // Convert number to string for select: 0 -> "on", 1 -> "off"
                        displayValue = processedValue === 0 ? 'on' : 'off';
                        break;
                    case 'm':
                        newKey = 'MW';
                        stateKey = 'hvac_mode'; // MODIFIÉ: mode -> hvac_mode
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1, 2].includes(processedValue)) return;
                        // Convert number to string for select: 0 -> "cool", 1 -> "heat", 2 -> "auto"
                        const modeNames = ['cool', 'heat', 'auto'];
                        displayValue = modeNames[processedValue];
                        break;
                    case 't':
                        newKey = 'TW';
                        stateKey = 'target_temperature';
                        const numValue = parseFloat(value);
                        if (!isNaN(numValue) && numValue >= 15.0 && numValue <= 30.0) {
                            processedValue = Math.round(numValue * 10) / 10;
                            displayValue = processedValue;
                        } else {
                            return;
                        }
                        break;
                    case 's':
                        newKey = 'SW';
                        stateKey = 'vent_speed';
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1, 2, 3].includes(processedValue)) return;
                        // Convert number to string for select: 0 -> "auto", 1 -> "low", 2 -> "middle", 3 -> "high"
                        const speedNames = ['auto', 'low', 'middle', 'high'];
                        displayValue = speedNames[processedValue];
                        break;
                    case 'd':
                        newKey = 'DW';
                        stateKey = 'unused';
                        processedValue = parseInt(value, 10);
                        if (isNaN(processedValue) || ![0, 1].includes(processedValue)) return;
                        displayValue = String(processedValue);
                        break;
                    default:
                        newKey = key.toUpperCase() + 'W';
                        stateKey = null;
                }
                
                result[newKey] = value; // Keep raw value for display
                if (stateKey) {
                    stateUpdate.state[stateKey] = displayValue; // Store as string for selects
                    result[stateKey] = displayValue; // Publish as string for selects
                }
                partsForCombined.push(`${newKey}${value}`);
            }
        });

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
            logger.error(`Aqara W100: Invalid endpoint for write: ${JSON.stringify(endpoint)}`);
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
            logger.info(`Aqara W100: Thermostat_Mode ON frame: ${frame.toString('hex')}`);
            
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

        logger.info(`Aqara W100: Thermostat_Mode set to ${value}`);
        return {};
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
            power: 'on',
            hvac_mode: 'cool', // MODIFIÉ: mode -> hvac_mode
            target_temperature: 15.0,
            vent_speed: 'auto',
            unused: '0'
        };
    },
    exposes: [
        // Thermostat Mode control
        e.binary('Thermostat_Mode', ea.ALL, 'ON', 'OFF')
            .withDescription('ON: Enables thermostat mode, buttons send encrypted payloads, and the middle line is displayed. OFF: Disables thermostat mode, buttons send actions, and the middle line is hidden.'),
        
        // P - Power control as Select
        e.enum('power', ea.ALL, ['on', 'off'])
            .withDescription('Power control: on = On, off = Off'),
        
        // M - Mode control as Select
        e.enum('hvac_mode', ea.ALL, ['cool', 'heat', 'auto']) // MODIFIÉ: mode -> hvac_mode
            .withDescription('Operating mode: cool, heat, or auto'),
        
        // T - Target Temperature as Number
        e.numeric('target_temperature', ea.ALL)
            .withUnit('°C')
            .withValueMin(15.0)
            .withValueMax(30.0)
            .withValueStep(0.1)
            .withDescription('Target temperature setpoint (15.0 - 30.0°C)'),
        
        // S - Fan Speed as Select
        e.enum('vent_speed', ea.ALL, ['auto', 'low', 'middle', 'high'])
            .withDescription('Fan speed: auto, low, middle, or high'),
        
        // D - Unused parameter as Select
        e.enum('unused', ea.ALL, ['0', '1'])
            .withDescription('Wind mode: 0 or 1'),
        
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
        // lumiExternalSensor(), // SUPPRIMÉ: Remplacé par l'appel avec options pour éviter conflit
        lumiExternalSensor({
            temperature: 'external_temperature', 
            humidity: 'external_humidity',
            battery: 'external_battery'
        }), // Renomme les entités du capteur externe
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