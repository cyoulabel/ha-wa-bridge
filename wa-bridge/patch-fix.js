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

try {
    hotfixClientResponseText();
    hotfixMediaMsgId();
} catch (err) {
    console.error('Error applying hotfix:', err);
    process.exit(1);
}
