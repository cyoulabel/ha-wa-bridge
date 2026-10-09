const fs = require('fs');
const path = require('path');

const WWEBJS_DIR = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src');

// ─── Hotfix 1: Client.js — response.text() sin catch ─────────────────
function hotfixClientResponseText() {
    const filePath = path.join(WWEBJS_DIR, 'Client.js');
    console.log(`[hotfix 1] Checking ${filePath}...`);

    if (!fs.existsSync(filePath)) {
        console.error('[hotfix 1] Client.js not found! Cannot apply hotfix.');
        process.exit(1); // Fail the build
    }

    let content = fs.readFileSync(filePath, 'utf8');

    // Pattern to look for: await response.text()
    // We want to replace it with: await response.text().catch(() => "")
    if (content.includes('await response.text().catch')) {
        console.log('[hotfix 1] Already applied. Skipping.');
    } else if (content.includes('await response.text()')) {
        const newContent = content.replace(
            /await response\.text\(\)/g,
            'await response.text().catch(() => "")'
        );
        fs.writeFileSync(filePath, newContent, 'utf8');
        console.log('[hotfix 1] Applied successfully!');
    } else {
        console.warn('[hotfix 1] Could not find "await response.text()" in Client.js. The library version might be different than expected.');
    }
}

// ─── Hotfix 2: envío de media (imagen/video/documento) ────────────────
// En whatsapp-web.js 1.34.7, sendMessage arma el mensaje con
// "...mediaOptions"; ese modelo trae la propiedad interna __x_id, que
// pisa el id del mensaje y WhatsApp Web truena con:
//   "Data passed to getter must include an id property (it's how we
//    memoize) but got undefined"
// Fix (propuesto upstream, wwebjs/whatsapp-web.js #201922): borrar
// message.__x_id justo después de construir el mensaje. Solo afecta
// envíos con media; los mensajes de texto no cambian.
function hotfixMediaMsgId() {
    const filePath = path.join(WWEBJS_DIR, 'util', 'Injected', 'Utils.js');
    const ANCLA = "// Bot's won't reply if canonicalUrl is set (linking)";
    const FIX = 'delete message.__x_id;';
    console.log(`[hotfix 2] Checking ${filePath}...`);

    if (!fs.existsSync(filePath)) {
        console.error('[hotfix 2] Utils.js not found! Cannot apply media hotfix.');
        process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf8');

    if (content.includes(FIX)) {
        console.log('[hotfix 2] Already applied (or fixed upstream). Skipping.');
        return;
    }
    if (!content.includes(ANCLA)) {
        // Sin el ancla no sabemos dónde va: mejor fallar el build que
        // publicar un bridge que no puede mandar fotos.
        console.error('[hotfix 2] Anchor comment not found in Utils.js — library changed. Review the media fix manually.');
        process.exit(1);
    }

    const newContent = content.replace(
        ANCLA,
        `${FIX} // hotfix: evita "Data passed to getter must include an id property"\n\n        ${ANCLA}`
    );
    fs.writeFileSync(filePath, newContent, 'utf8');

    if (!fs.readFileSync(filePath, 'utf8').includes(FIX)) {
        console.error('[hotfix 2] Write verification failed.');
        process.exit(1);
    }
    console.log('[hotfix 2] Applied successfully!');
}

// ─── Hotfix 3: WhatsApp Web 2.3000.x renombró id._serialized → id.$1 ──
// Síntoma: getChats()/getChatById()/getChat() truenan con "r: r" y los
// mensajes de vecinos (@c.us) no llegan. Causa: lastReceivedKey._serialized
// queda undefined y Msg.getMessagesById([undefined]) falla; un solo chat
// malo tumba todo getChats(). Fix: (a) leer la llave con fallback a $1,
// (b) envolver el cálculo de lastMessage en try/catch, (c) getChats ignora
// los chats que fallen en lugar de rechazar todo.
// (wwebjs/whatsapp-web.js #201845, #201862; raulpetruta/ha-wa-bridge #48)
function hotfixSerializedKey() {
    const filePath = path.join(WWEBJS_DIR, 'util', 'Injected', 'Utils.js');
    console.log(`[hotfix 3] Checking ${filePath}...`);
    if (!fs.existsSync(filePath)) {
        console.error('[hotfix 3] Utils.js not found!');
        process.exit(1);
    }
    let c = fs.readFileSync(filePath, 'utf8');
    if (c.includes('hotfix3-applied')) {
        console.log('[hotfix 3] Already applied. Skipping.');
        return;
    }

    // (a)+(b) lastMessage
    const iA = c.indexOf('model.lastMessage = null;');
    const iB = c.indexOf('delete model.msgs;', iA);
    if (iA < 0 || iB < 0) {
        console.error('[hotfix 3] lastMessage block not found — library changed.');
        process.exit(1);
    }
    const bloque = `model.lastMessage = null; // hotfix3-applied
        try {
            if (model.msgs && model.msgs.length && chat.lastReceivedKey) {
                const k = chat.lastReceivedKey;
                const kid = k._serialized || k.$1 || (typeof k.toString === 'function' ? String(k) : null);
                if (kid && kid !== '[object Object]') {
                    const lastMessage =
                        window.require('WAWebCollections').Msg.get(kid) ||
                        (await window.require('WAWebCollections').Msg.getMessagesById([kid]))?.messages?.[0];
                    lastMessage && (model.lastMessage = window.WWebJS.getMessageModel(lastMessage));
                }
            }
        } catch (e) {
            model.lastMessage = null;
        }

        `;
    c = c.slice(0, iA) + bloque + c.slice(iB);

    // (c) getChats tolerante
    const viejo = `const chatPromises = chats.map((chat) =>
            window.WWebJS.getChatModel(chat),
        );
        return await Promise.all(chatPromises);`;
    const nuevo = `const chatPromises = chats.map((chat) =>
            window.WWebJS.getChatModel(chat).catch(() => null),
        );
        return (await Promise.all(chatPromises)).filter(Boolean);`;
    if (!c.includes(viejo)) {
        console.error('[hotfix 3] getChats block not found — library changed.');
        process.exit(1);
    }
    c = c.replace(viejo, nuevo);
    fs.writeFileSync(filePath, c, 'utf8');
    if (!fs.readFileSync(filePath, 'utf8').includes('hotfix3-applied')) {
        console.error('[hotfix 3] Write verification failed.');
        process.exit(1);
    }
    console.log('[hotfix 3] Applied successfully!');
}

try {
    hotfixClientResponseText();
    hotfixMediaMsgId();
    hotfixSerializedKey();
} catch (err) {
    console.error('Error applying hotfix:', err);
    process.exit(1);
}
