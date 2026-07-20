const { Client, LocalAuth, MessageMedia, Poll, ScheduledEvent } = require('whatsapp-web.js');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode');
const fs = require('fs');

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
    client.on('message_create', async msg => {
        // If detect_own_messages is false, ignore messages sent by the bot itself
        if (msg.fromMe && !detectOwnMessages) {
            return;
        }

        let chatInfo = {};
        try {
            const chat = await msg.getChat();
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
