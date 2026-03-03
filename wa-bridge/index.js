const { Client, LocalAuth, MessageMedia, Poll } = require('whatsapp-web.js');
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

// Optional list of group names to forward (applies to all modes except 'disabled').
// If empty, no group-name filtering is applied.
let allowedGroups = configOptions.allowed_groups || [];
if (typeof allowedGroups === 'string') {
    // Support comma-separated env var: ALLOWED_GROUPS="Group A,Group B"
    allowedGroups = allowedGroups.split(',').map(g => g.trim()).filter(Boolean);
}
const allowedGroupsLower = allowedGroups.map(g => g.toLowerCase());

console.log(`Incoming messages mode: ${incomingMode}`);
if (allowedGroupsLower.length > 0) {
    console.log(`Allowed groups filter: ${allowedGroups.join(', ')}`);
}

const PORT = 3000;

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
                const { number, message: text, group_name, media } = data;
                await handleSendMessage(number, text, group_name, media);
            } else if (data.type === 'send_poll') {
                const { number, group_name, message: pollQuestion, options, allow_multiple_answers } = data;
                await handleSendPoll(number, group_name, pollQuestion, options, allow_multiple_answers);
            } else if (data.type === 'broadcast') {
                const { targets, message: text, media } = data;
                if (Array.isArray(targets) && targets.length > 0) {
                   console.log(`Broadcasting message to ${targets.length} targets.`);
                   for (const target of targets) {
                       await handleSendMessage(target, text, target, media);
                   }
                } else {
                    console.error('No targets provided for broadcast.');
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
});

async function resolveChatId(number, group_name) {
    let chatId = number;

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

    // Check if chatId is a valid JID (contains @)
    if (chatId && !chatId.includes('@')) {
         // Basic format check for number (e.g. 1234567890@c.us)
        chatId = `${chatId}@c.us`;
    }
    
    return chatId;
}

async function handleSendMessage(number, text, group_name, media) {
    const chatId = await resolveChatId(number, group_name);

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

async function handleSendPoll(number, group_name, pollQuestion, options, allow_multiple_answers) {
    const chatId = await resolveChatId(number, group_name);

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
                isGroup: chat.isGroup
            };

            // groups_only mode: skip non-group messages
            if (incomingMode === 'groups_only' && !chat.isGroup) {
                return;
            }

            // allowed_groups filter: skip messages from groups not in the list
            if (allowedGroupsLower.length > 0) {
                if (!chat.isGroup || !allowedGroupsLower.includes(chat.name.toLowerCase())) {
                    return;
                }
            }
        } catch (err) {
            console.error('Error fetching chat info:', err);
        }

        console.log('MESSAGE RECEIVED', msg);

        // Broadcast incoming message to HA
        broadcast({
            type: 'message',
            data: {
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
            }
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
