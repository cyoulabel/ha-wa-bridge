const { Client, LocalAuth, MessageMedia, Poll, ScheduledEvent } = require('whatsapp-web.js');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

let configOptions = {};
try {
    if (fs.existsSync('/data/options.json')) {
        configOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    }
} catch (err) {
    console.error('Error reading options.json:', err);
}

const detectOwnMessages = configOptions.detect_own_messages || process.env.DETECT_OWN_MESSAGES === 'true' || false;

// Incoming message filtering
// Mode: 'all' (default) | 'disabled' | 'groups_only'
const incomingMode = configOptions.incoming_messages_mode || process.env.INCOMING_MESSAGES_MODE || 'all';

// Optional list of group names to forward (applies to groups_only mode and as a filter in 'all' mode).
// If empty, no group-name filtering is applied.
let allowedGroups = configOptions.allowed_groups || process.env.ALLOWED_GROUPS || [];
if (typeof allowedGroups === 'string') {
    // Support comma-separated env var: ALLOWED_GROUPS="Group A,Group B"
    allowedGroups = allowedGroups.split(',').map(g => g.trim()).filter(Boolean);
}
const allowedGroupsLower = allowedGroups.map(g => g.toLowerCase());

// Optional list of phone numbers to forward (applies to numbers_only mode and as a filter in 'all' mode).
// Numbers should be in international format without the '+': e.g. "40741234567"
// If empty, no number filtering is applied.
let allowedNumbers = configOptions.allowed_numbers || process.env.ALLOWED_NUMBERS || [];
if (typeof allowedNumbers === 'string') {
    // Support comma-separated env var: ALLOWED_NUMBERS="40741234567,49123456789"
    allowedNumbers = allowedNumbers.split(',').map(n => n.trim()).filter(Boolean);
}
const allowedNumbersSet = new Set(allowedNumbers.map(n => `${n}@c.us`));

// Incoming message logging level
// Mode: 'FULL' (default) | 'COMPACT' | 'NONE'
const incomingLogLevel = (configOptions.incoming_message_log_level || process.env.INCOMING_MESSAGE_LOG_LEVEL || 'FULL').toUpperCase();

// Carpeta donde se guardan temporalmente imágenes/audios recibidos
// antes de que HA los procese. Privada por default (fuera de
// /config/www) para que las fotos de vecinos nunca queden accesibles
// públicamente por internet.
const MEDIA_DIR = configOptions.media_dir || process.env.MEDIA_DIR || '/config/shell_scripts/wa_media';
console.log(`Media storage directory: ${MEDIA_DIR}`);

console.log(`Incoming messages mode: ${incomingMode}`);
console.log(`Incoming message log level: ${incomingLogLevel}`);
if (allowedGroupsLower.length > 0) {
    console.log(`Allowed groups filter: ${allowedGroups.join(', ')}`);
}
if (allowedNumbersSet.size > 0) {
    console.log(`Allowed numbers filter: ${allowedNumbers.join(', ')}`);
}

// Helper to log incoming data based on log level
function logIncomingData(type, data, rawObj) {
    if (incomingLogLevel === 'NONE') return;

    if (incomingLogLevel === 'COMPACT') {
        const sender = data.from || data.voter || 'unknown';
        const group = data.isGroup ? ` (Group: ${data.chatName})` : (data.group_id ? ` (Group ID: ${data.group_id})` : '');
        console.log(`[${type}] received from ${sender}${group}`);
    } else {
        // FULL logging
        console.log(`[${type}] RECEIVED`, rawObj);
    }
}

const PORT = 3000;

// ── Descifrado manual de media de WhatsApp ──────────────────────────
// Cuando msg.downloadMedia() falla (bug de whatsapp-web.js con
// remitentes LID), descargamos y desciframos el archivo nosotros
// mismos usando el algoritmo público de WhatsApp: HKDF-SHA256 sobre
// mediaKey para derivar iv/cipherKey/macKey, luego AES-256-CBC.
// No depende de getChat()/downloadMedia() en absoluto — evita el bug.
const crypto = require('crypto');
const https = require('https');

const MEDIA_KEYS_INFO = {
    image: 'WhatsApp Image Keys',
    video: 'WhatsApp Video Keys',
    audio: 'WhatsApp Audio Keys',
    ptt: 'WhatsApp Audio Keys',
    document: 'WhatsApp Document Keys',
    // Los stickers son técnicamente webp (variante de imagen) y
    // comparten la misma derivación de claves que las imágenes. Sin
    // esta entrada, caían por default a 'WhatsApp Document Keys'
    // (incorrecto), causando "bad decrypt" al descifrar manualmente.
    sticker: 'WhatsApp Image Keys',
};

function descargarBytes(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} descargando media`));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function descifrarMediaWhatsApp(url, mediaKeyBase64, tipo) {
    const infoStr = MEDIA_KEYS_INFO[tipo] || MEDIA_KEYS_INFO.document;
    const mediaKey = Buffer.from(mediaKeyBase64, 'base64');

    // HKDF-SHA256: 112 bytes derivados -> iv(16) + cipherKey(32) + macKey(32) + refKey(32, sin usar)
    const expandedKey = crypto.hkdfSync(
        'sha256', mediaKey, Buffer.alloc(0), Buffer.from(infoStr, 'utf-8'), 112
    );
    const expanded = Buffer.from(expandedKey);
    const iv = expanded.subarray(0, 16);
    const cipherKey = expanded.subarray(16, 48);
    // macKey (expanded.subarray(48, 80)) se usaría para verificar
    // integridad — lo omitimos por simplicidad, no es crítico aquí.

    const encrypted = await descargarBytes(url);
    // Los últimos 10 bytes son el MAC, no forman parte del ciphertext real.
    const ciphertext = encrypted.subarray(0, encrypted.length - 10);

    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted;
}

// Caché interno LID -> teléfono real. Se alimenta de varias fuentes
// (mensajes recibidos, evento contact_changed) para que el bridge
// mismo pueda resolver LIDs de forma autónoma, sin depender de que
// HA aprenda el mapeo por separado.
const lidPhoneCache = new Map();

function cacheLid(lid, phone) {
    if (!lid || !phone) return;
    const lidKey = lid.includes('@') ? lid.split('@')[0] : lid;
    const phoneClean = phone.includes('@') ? phone : `${phone}@c.us`;
    lidPhoneCache.set(lidKey, phoneClean);
}

function lookupLid(lid) {
    if (!lid) return null;
    const lidKey = lid.includes('@') ? lid.split('@')[0] : lid;
    return lidPhoneCache.get(lidKey) || null;
}

// Initialize WebSocket Server
const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket server started on port ${PORT}`);

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: process.env.WA_DATA_PATH || './.wwebjs_auth'
    }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote', 
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--disable-web-security',
            '--ignore-certificate-errors'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    },
    authTimeoutMs: 0 // Wait indefinitely for QR scan
});

let lastQr = null;
let isReady = false;

// WebSocket Connection Handler
wss.on('connection', (ws) => {
    console.log('New client connected');

    // Send current state to new client
    if (isReady) {
        ws.send(JSON.stringify({ type: 'status', status: 'ready' }));
    } else if (lastQr) {
        ws.send(JSON.stringify({ type: 'qr', data: lastQr }));
    } else {
        ws.send(JSON.stringify({ type: 'status', status: 'initializing' }));
    }

    // Handle incoming messages from HA
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received command:', data);

            if (data.type === 'send_message') {
                const { number, message: text, group_name, group_id, media } = data;
                await handleSendMessage(number, text, group_name, group_id, media);
            } else if (data.type === 'send_poll') {
                const { number, group_name, group_id, message: pollQuestion, options, allow_multiple_answers } = data;
                await handleSendPoll(number, group_name, group_id, pollQuestion, options, allow_multiple_answers);
            } else if (data.type === 'broadcast') {
                const { targets, message: text, media } = data;
                if (Array.isArray(targets) && targets.length > 0) {
                   console.log(`Broadcasting message to ${targets.length} targets.`);
                   for (const target of targets) {
                       await handleSendMessage(target, text, target, null, media);
                   }
                } else {
                    console.error('No targets provided for broadcast.');
                }
            } else if (data.type === 'get_groups') {
                await handleGetGroups(ws);
            } else if (data.type === 'set_group_subject') {
                const { group_id, subject } = data;
                await handleSetGroupSubject(ws, group_id, subject);
            } else if (data.type === 'set_group_picture') {
                const { group_id, media } = data;
                await handleSetGroupPicture(ws, group_id, media);
            } else if (data.type === 'send_event') {
                const { number, group_name, group_id, name, description, location, start_time, end_time, call_type } = data;
                await handleSendEvent(number, group_name, group_id, name, description, location, start_time, end_time, call_type);
            } else if (data.type === 'resolve_lids') {
                // Recibe una lista de teléfonos y pregunta directo a
                // WhatsApp por el LID asociado a cada uno (si existe),
                // usando la API oficial — sin depender de que el vecino
                // mande un mensaje primero.
                const { phones } = data;
                try {
                    const phoneIds = (phones || []).map(p => {
                        const digits = String(p).replace(/[^0-9]/g, '');
                        return `${digits}@c.us`;
                    });
                    const results = await client.getContactLidAndPhone(phoneIds);
                    ws.send(JSON.stringify({ type: 'resolve_lids_response', data: results }));
                } catch (err) {
                    console.error('Error resolving LIDs:', err);
                    ws.send(JSON.stringify({ type: 'resolve_lids_response', data: [], error: err.message }));
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
});

async function resolveChatId(number, group_name, group_id) {
    let chatId = number;

    // If a group_id is provided, use it directly (most stable identifier)
    if (group_id) {
        chatId = group_id;
        if (!chatId.includes('@')) {
            chatId = `${chatId}@g.us`;
        }
        console.log(`Using group ID directly: ${chatId}`);
        return chatId;
    }

    if (group_name) {
        // optimistically try to find a group first if group_name is provided
        try {
            const chats = await client.getChats();
            const group = chats.find(chat => chat.isGroup && chat.name.toLowerCase() === group_name.toLowerCase());

            if (group) {
                chatId = group.id._serialized;
                console.log(`Found group '${group.name}' with ID: ${chatId}`);
            }
        } catch (err) {
            console.error('Error fetching chats:', err);
        }
    }

    // Si nos pasaron directamente un LID conocido, resolver al teléfono
    // real usando nuestro caché antes de seguir.
    if (chatId && chatId.includes('@lid')) {
        const cached = lookupLid(chatId);
        if (cached) {
            console.log(`Resolved cached LID ${chatId} -> ${cached}`);
            chatId = cached;
        }
    }

    // Check if chatId is a valid JID (contains @)
    if (chatId && !chatId.includes('@')) {
        // Validar y resolver el número correctamente contra WhatsApp
        // antes de mandarlo — evita mandar a un ID mal formado, y de
        // paso confirma que el número sí tiene WhatsApp activo (si no
        // lo tiene, getNumberId regresa null y avisamos aquí mismo en
        // vez de fallar silenciosamente más adelante en sendMessage).
        try {
            const numberId = await client.getNumberId(chatId);
            if (numberId && numberId._serialized) {
                chatId = numberId._serialized;
            } else {
                console.error(`Number ${chatId} is not registered on WhatsApp.`);
                return null;
            }
        } catch (err) {
            console.error(`Error validating number ${chatId} via getNumberId:`, err);
            // Fallback al formato clásico si getNumberId falla por algún motivo
            chatId = `${chatId}@c.us`;
        }
    }

    return chatId;
}

async function handleSendMessage(number, text, group_name, group_id, media) {
    const chatId = await resolveChatId(number, group_name, group_id);

    if (chatId) {
        try {
            if (media) {
                const messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
                await client.sendMessage(chatId, messageMedia, { caption: text });
                console.log(`Sent media message to ${chatId}: ${text || '(no caption)'}`);
            } else {
                await client.sendMessage(chatId, text);
                console.log(`Sent message to ${chatId}: ${text}`);
            }
        } catch (sendErr) {
            console.error(`Failed to send message to ${chatId}:`, sendErr);
        }
    } else {
         console.error('No valid destination (number or group_name) provided.');
    }
}

async function handleSendPoll(number, group_name, group_id, pollQuestion, options, allow_multiple_answers) {
    const chatId = await resolveChatId(number, group_name, group_id);

    if (chatId) {
        try {
            const poll = new Poll(pollQuestion, options, { allowMultipleAnswers: allow_multiple_answers });
            await client.sendMessage(chatId, poll);
            console.log(`Sent poll to ${chatId}: ${pollQuestion}`);
        } catch (sendErr) {
            console.error(`Failed to send poll to ${chatId}:`, sendErr);
        }
    } else {
         console.error('No valid destination (number or group_name) provided for poll.');
    }
}

async function handleSendEvent(number, group_name, group_id, eventName, eventDescription, eventLocation, eventStartTime, eventEndTime, eventCallType) {
    const chatId = await resolveChatId(number, group_name, group_id);

    if (chatId) {
        try {
            const options = {
                callType: eventCallType || 'none'
            };
            if (eventDescription) options.description = eventDescription;
            if (eventLocation) options.location = eventLocation;
            if (eventEndTime) options.endTime = new Date(eventEndTime);

            const event = new ScheduledEvent(eventName, new Date(eventStartTime), options);
            await client.sendMessage(chatId, event);
            console.log(`Sent event to ${chatId}: ${eventName}`);
        } catch (sendErr) {
            console.error(`Failed to send event to ${chatId}:`, sendErr);
        }
    } else {
        console.error('No valid destination (number or group_name) provided for event.');
    }
}

async function handleGetGroups(ws) {
    try {
        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name
            }));
        console.log(`Returning ${groups.length} groups.`);
        ws.send(JSON.stringify({ type: 'get_groups_response', data: groups }));
    } catch (err) {
        console.error('Error fetching groups:', err);
        ws.send(JSON.stringify({ type: 'get_groups_response', data: [], error: err.message }));
    }
}

async function handleSetGroupSubject(ws, group_id, subject) {
    if (!group_id || !subject) {
        console.error('group_id and subject are required for set_group_subject.');
        ws.send(JSON.stringify({ type: 'set_group_subject_response', success: false, error: 'group_id and subject are required' }));
        return;
    }

    let chatId = group_id;
    if (!chatId.includes('@')) {
        chatId = `${chatId}@g.us`;
    }

    try {
        const chat = await client.getChatById(chatId);
        if (!chat.isGroup) {
            console.error(`Chat ${chatId} is not a group.`);
            ws.send(JSON.stringify({ type: 'set_group_subject_response', success: false, error: 'Chat is not a group' }));
            return;
        }
        const result = await chat.setSubject(subject);
        console.log(`Set group subject for ${chatId} to "${subject}": ${result}`);
        ws.send(JSON.stringify({ type: 'set_group_subject_response', success: result }));
    } catch (err) {
        console.error(`Failed to set group subject for ${chatId}:`, err);
        ws.send(JSON.stringify({ type: 'set_group_subject_response', success: false, error: err.message }));
    }
}

async function handleSetGroupPicture(ws, group_id, media) {
    if (!group_id || !media) {
        console.error('group_id and media are required for set_group_picture.');
        ws.send(JSON.stringify({ type: 'set_group_picture_response', success: false, error: 'group_id and media are required' }));
        return;
    }

    let chatId = group_id;
    if (!chatId.includes('@')) {
        chatId = `${chatId}@g.us`;
    }

    try {
        const chat = await client.getChatById(chatId);
        if (!chat.isGroup) {
            console.error(`Chat ${chatId} is not a group.`);
            ws.send(JSON.stringify({ type: 'set_group_picture_response', success: false, error: 'Chat is not a group' }));
            return;
        }
        const messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
        const result = await chat.setPicture(messageMedia);
        console.log(`Set group picture for ${chatId}: ${result}`);
        ws.send(JSON.stringify({ type: 'set_group_picture_response', success: result }));
    } catch (err) {
        console.error(`Failed to set group picture for ${chatId}:`, err);
        ws.send(JSON.stringify({ type: 'set_group_picture_response', success: false, error: err.message }));
    }
}

// Broadcast helper
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(JSON.stringify(data));
        }
    });
}

// WhatsApp Client Events
client.on('qr', (qr) => {
    console.log('QR Code received');
    lastQr = qr;
    // Generate terminal QR for local debugging logs
    qrcode.toString(qr, { type: 'terminal', small: true }, function (err, url) {
        if (!err) console.log(url);
    });
    
    broadcast({ type: 'qr', data: qr });
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    isReady = true;
    lastQr = null;
    broadcast({ type: 'status', status: 'ready' });
});

client.on('authenticated', () => {
    console.log('Authenticated');
    broadcast({ type: 'status', status: 'authenticated' });
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    broadcast({ type: 'status', status: 'auth_failure' });
});

// Cuando alguien cambia de número (o adopta un username, que WhatsApp
// trata internamente como un cambio de ID), actualizamos el caché
// LID->teléfono de inmediato, sin esperar a que llegue un mensaje suyo.
client.on('contact_changed', (message, oldId, newId, isContact) => {
    console.log(`Contact changed: ${oldId} -> ${newId} (isContact: ${isContact})`);

    // Evitar cachear el número propio del bot como si fuera el teléfono
    // real de un contacto — esto puede pasar por sincronización interna
    // de WhatsApp y corrompería futuras resoluciones de LID.
    const ownNumber = client.info && client.info.wid ? client.info.wid._serialized : null;
    if (newId === ownNumber || oldId === ownNumber) {
        console.log('Skipping contact_changed cache — involves bot\'s own number.');
        broadcast({ type: 'contact_changed', data: { oldId, newId, isContact } });
        return;
    }

    if (oldId && oldId.includes('@lid') && newId && !newId.includes('@lid')) {
        cacheLid(oldId, newId);
    } else if (newId && newId.includes('@lid') && oldId && !oldId.includes('@lid')) {
        cacheLid(newId, oldId);
    }
    broadcast({
        type: 'contact_changed',
        data: { oldId, newId, isContact }
    });
});

client.on('vote_update', async vote => {

    let parentMsgId = null;
    let groupId = null;
    let voter = vote.voter;
    let isGroup = false;
    let chatName = '';
    
    // Extract purely the phone number from the JID format
    if (voter && typeof voter === 'string') {
        voter = voter.split('@')[0];
        if (voter.includes(':')) {
            voter = voter.split(':')[0];
        }
    }
    
    if (vote.parentMessage) {
        if (vote.parentMessage.id && vote.parentMessage.id._serialized) {
            parentMsgId = vote.parentMessage.id._serialized;
        }
        
        let to = vote.parentMessage.to;
        if (to) {
            isGroup = to.includes('@g.us');
            if (isGroup) {
               groupId = to.split('@')[0];
            }
        }
        
        // We need the chat name for group filtering
        try {
            const chat = await client.getChatById(to || vote.parentMessage.id.remote);
            chatName = chat.name;
            isGroup = chat.isGroup;
        } catch (err) {
            console.error('Error fetching chat info for poll vote:', err);
        }
    }
    
    // groups_only mode: skip non-group votes
    if (incomingMode === 'groups_only' && !isGroup) {
        return;
    }

    // numbers_only mode: skip group votes and votes not from allowed numbers
    if (incomingMode === 'numbers_only') {
        if (isGroup || !allowedNumbersSet.has(`${voter}@c.us`)) {
            return;
        }
    }

    // allowed_groups filter: skip votes from groups not in the list
    if (allowedGroupsLower.length > 0) {
        if (!isGroup || !allowedGroupsLower.includes((chatName || '').toLowerCase())) {
            return;
        }
    }

    // allowed_numbers filter: skip votes from numbers not in the list
    if (allowedNumbersSet.size > 0 && incomingMode !== 'numbers_only') {
        if (isGroup || !allowedNumbersSet.has(`${voter}@c.us`)) {
            return;
        }
    }

    const payloadData = {
        voter: voter,
        group_id: groupId,
        selectedOptions: vote.selectedOptions,
        pollCreationMessageId: parentMsgId,
        timestamp: vote.timestamp
    };

    logIncomingData('VOTE_UPDATE', payloadData, vote);

    broadcast({
        type: 'poll_vote',
        data: payloadData
    });
});

if (incomingMode !== 'disabled') {
    // Tipos de mensaje que NO son contenido real de un usuario — son
    // notificaciones internas del protocolo de WhatsApp (cambios de
    // cuenta de negocio, protocolo E2E, etc.). Sin este filtro, estos
    // mensajes con body vacío se reenviaban a HA como si fueran
    // mensajes reales, causando respuestas automáticas confusas a
    // números que nunca escribieron nada.
    const IGNORED_MESSAGE_TYPES = new Set([
        'notification_template',
        'e2e_notification',
        'notification',
        'gp2',
        'protocol',
        'ciphertext',
        'call_log',
        'group_notification',
        'broadcast_notification'
    ]);

    client.on('message_create', async msg => {
        // If detect_own_messages is false, ignore messages sent by the bot itself
        if (msg.fromMe && !detectOwnMessages) {
            return;
        }

        // Descartar notificaciones internas de WhatsApp antes de hacer
        // cualquier trabajo (getChat, resolución de LID, etc.) — no son
        // mensajes de un usuario real.
        if (IGNORED_MESSAGE_TYPES.has(msg.type)) {
            console.log(`Ignoring system message of type '${msg.type}' from ${msg.from}`);
            return;
        }

        let chatInfo = {};
        try {
            // Límite de 8s — igual que con downloadMedia(), este bug de
            // LID a veces cuelga la llamada en vez de fallar rápido.
            const chat = await Promise.race([
                msg.getChat(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('getChat timeout (8s)')), 8000)
                )
            ]);
            chatInfo = {
                chatName: chat.name,
                isGroup: chat.isGroup,
                groupId: chat.isGroup ? chat.id._serialized : null
            };

            // groups_only mode: skip non-group messages
            if (incomingMode === 'groups_only' && !chat.isGroup) {
                return;
            }

            // numbers_only mode: skip group messages and messages not from allowed numbers
            if (incomingMode === 'numbers_only') {
                if (chat.isGroup || (!allowedNumbersSet.has(msg.from) && !allowedNumbersSet.has(msg.author))) {
                    return;
                }
            }

            // allowed_groups filter: skip messages from groups not in the list
            if (allowedGroupsLower.length > 0) {
                if (!chat.isGroup || !allowedGroupsLower.includes(chat.name.toLowerCase())) {
                    return;
                }
            }

            // allowed_numbers filter: skip messages from numbers not in the list
            if (allowedNumbersSet.size > 0 && incomingMode !== 'numbers_only') {
                if (chat.isGroup || (!allowedNumbersSet.has(msg.from) && !allowedNumbersSet.has(msg.author))) {
                    return;
                }
            }
        } catch (err) {
            console.error('Error fetching chat info:', err);
            // Contactos que usan LID (número oculto) hacen que
            // msg.getChat() falle — sin este default, isGroup/chatName/
            // groupId quedan ausentes del payload, y cualquier
            // automatización de HA que dependa de isGroup==false nunca
            // se dispara. No podemos asumir isGroup:false a ciegas: un
            // mensaje DE GRUPO también puede fallar aquí si el autor
            // dentro del grupo usa LID. Inferimos isGroup del formato
            // del JID (los grupos siempre terminan en @g.us).
            const inferredIsGroup = (msg.from || '').endsWith('@g.us');
            chatInfo = {
                chatName: msg.from,
                isGroup: inferredIsGroup,
                groupId: inferredIsGroup ? msg.from : null
            };
        }

        const payloadData = {
            from: msg.from,
            to: msg.to,
            body: msg.body,
            timestamp: msg.timestamp,
            hasMedia: msg.hasMedia,
            messageType: msg.type,
            author: msg.author,
            deviceType: msg.deviceType,
            isForwarded: msg.isForwarded,
            fromMe: msg.fromMe,
            ...chatInfo
        };

        // Si el remitente (o autor, en grupos) usa LID, intentar resolver
        // su número real. Primero revisamos nuestro caché interno
        // (poblado por contact_changed o resoluciones previas); si no
        // está, usamos la API oficial, y si esa falla, probamos el
        // campo Contact#number como último respaldo.
        const senderId = msg.author || msg.from;
        if (senderId && senderId.includes('@lid')) {
            let resolved = lookupLid(senderId);

            if (!resolved) {
                try {
                    const lidResults = await client.getContactLidAndPhone([senderId]);
                    if (lidResults && lidResults[0] && lidResults[0].pn) {
                        resolved = lidResults[0].pn;
                    }
                } catch (err) {
                    console.error('Error resolving LID via getContactLidAndPhone:', err);
                }
            }

            if (!resolved) {
                try {
                    const contact = await client.getContactById(senderId);
                    if (contact && contact.number) {
                        resolved = `${contact.number}@c.us`;
                    }
                } catch (err) {
                    console.error('Error resolving LID via getContactById fallback:', err);
                }
            }

            if (resolved) {
                payloadData.resolvedPhone = resolved;
                cacheLid(senderId, resolved);
            }
        }

        // Si el mensaje es una respuesta a otro (reply/quote), incluir
        // el texto del mensaje original como contexto — así el bot
        // puede entender a qué se refiere el vecino sin que lo repita.
        if (msg.hasQuotedMsg) {
            try {
                const quoted = await Promise.race([
                    msg.getQuotedMessage(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('getQuotedMessage timeout (5s)')), 5000)
                    )
                ]);
                if (quoted) {
                    payloadData.quotedBody = quoted.body || '';
                    payloadData.quotedFromMe = quoted.fromMe;
                }
            } catch (err) {
                console.error('Error fetching quoted message:', err);
            }
        }

        // Si el mensaje trae imagen o nota de voz, descargar el contenido
        // real y adjuntarlo en base64 — así HA puede procesarlo (análisis
        // de foto con IA, transcripción de audio, etc.) sin depender de
        // que el script de HA vuelva a pedirle el archivo al bridge.
        const MAX_MEDIA_SIZE_MB = 15;

        function guardarMediaEnDisco(base64Data, mimetype) {
            const ext = (mimetype && mimetype.split('/')[1]) ? mimetype.split('/')[1].split(';')[0] : 'bin';
            const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
            const filepath = path.join(MEDIA_DIR, filename);
            fs.mkdirSync(MEDIA_DIR, { recursive: true });
            fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
            return filepath;
        }

        if (msg.hasMedia && (msg.type === 'image' || msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'sticker')) {
            try {
                // Límite de 8s — si downloadMedia() se cuelga (en vez de
                // fallar rápido con el bug de LID), no queremos esperar
                // indefinidamente y dejar el mensaje sin procesar.
                const media = await Promise.race([
                    msg.downloadMedia(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('downloadMedia timeout (8s)')), 8000)
                    )
                ]);
                if (media && media.data) {
                    const sizeMB = (media.data.length * 0.75) / (1024 * 1024); // aprox. base64 -> bytes
                    if (sizeMB <= MAX_MEDIA_SIZE_MB) {
                        const filepath = guardarMediaEnDisco(media.data, media.mimetype);
                        payloadData.mediaPath = filepath;
                        payloadData.mediaMimetype = media.mimetype;
                    } else {
                        console.error(`Media too large (${sizeMB.toFixed(1)}MB), skipping download.`);
                    }
                }
            } catch (err) {
                console.error('Error downloading media:', err);
                // downloadMedia() falla con el mismo bug de LID que
                // getChat() — internamente también necesita resolver
                // la identidad del remitente. Como plan B, intentamos
                // descifrar el archivo NOSOTROS MISMOS usando la URL
                // directa + mediaKey que WhatsApp ya incluye en el
                // mensaje — esto evita por completo el código interno
                // roto de whatsapp-web.js, dando la imagen COMPLETA en
                // buena calidad (no solo el thumbnail borroso).
                try {
                    const deprecatedUrl = msg._data && msg._data.deprecatedMms3Url;
                    const directPath = msg._data && msg._data.directPath;
                    const mediaKey = msg._data && msg._data.mediaKey;

                    // deprecatedMms3Url a veces viene truncada a solo el
                    // dominio (ej. "https://a.whatsapp.net", sin ruta).
                    // Si eso pasa, la reconstruimos con directPath, que
                    // sí trae la ruta completa del archivo.
                    let mediaUrl = deprecatedUrl;
                    const urlPareceIncompleta = !deprecatedUrl || !deprecatedUrl.includes('/v/');
                    if (urlPareceIncompleta && directPath) {
                        mediaUrl = `https://mmg.whatsapp.net${directPath}`;
                        console.log('deprecatedMms3Url incompleta, reconstruida con directPath.');
                    }

                    if (mediaUrl && mediaKey) {
                        const decrypted = await descifrarMediaWhatsApp(mediaUrl, mediaKey, msg.type);
                        // FIX: msg.mimetype casi siempre es undefined en whatsapp-web.js;
                        // el mimetype real viene en msg._data.mimetype (ej. 'image/webp'
                        // para stickers). Usar el fallback fijo 'image/jpeg' aquí guardaba
                        // bytes WEBP con extensión .jpeg, rompiendo el pipeline de visión
                        // (Kimi/Gemini) río abajo con "no pude procesar la imagen".
                        const mimetype = (msg._data && msg._data.mimetype) || 'image/jpeg';
                        const filepath = guardarMediaEnDisco(decrypted.toString('base64'), mimetype);
                        payloadData.mediaPath = filepath;
                        payloadData.mediaMimetype = mimetype;
                        console.log('Media descifrada manualmente con éxito (bypass de downloadMedia).');
                    } else {
                        throw new Error('Faltan deprecatedMms3Url/directPath o mediaKey para descifrado manual');
                    }
                } catch (err2) {
                    console.error('Descifrado manual también falló:', err2);
                    // Último recurso: thumbnail de baja resolución
                    // embebido en el mensaje, si existe.
                    const rawBody = (msg._data && msg._data.body) || '';
                    if (rawBody && rawBody.length > 100 && /^[A-Za-z0-9+/=]+$/.test(rawBody.slice(0, 50))) {
                        // FIX: mismo problema que arriba, usar msg._data.mimetype real.
                        const mimetype = (msg._data && msg._data.mimetype) || 'image/jpeg';
                        const filepath = guardarMediaEnDisco(rawBody, mimetype);
                        payloadData.mediaPath = filepath;
                        payloadData.mediaMimetype = mimetype;
                        payloadData.isThumbnailFallback = true;
                        console.log('Using embedded thumbnail as last-resort fallback.');
                    }
                }
            }
        }

        logIncomingData('MESSAGE', payloadData, msg);

        // Broadcast incoming message to HA
        broadcast({
            type: 'message',
            data: payloadData
        });
    });
} else {
    console.log('Incoming message handling is DISABLED. The bridge will not forward any received messages to Home Assistant.');
}

// Start the client with retry logic
const startClient = async () => {
    console.log('Initializing WhatsApp client...');
    try {
        // Small delay to ensure network is stable
        await new Promise(resolve => setTimeout(resolve, 2000));
        await client.initialize();
    } catch (err) {
        console.error('Failed to initialize client:', err);
        
        // Exit to allow Docker/Supervisor to restart the container
        console.log('Exiting to trigger restart and lock cleanup...');
        process.exit(1);
    }
};

startClient();
