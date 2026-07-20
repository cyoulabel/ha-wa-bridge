# Changelog

## 2.1.0

### Fixed
- **LID (username) support in `message_create`**: when a contact uses a
  WhatsApp username instead of a phone number, `msg.getChat()` throws and
  the payload sent to Home Assistant was missing `isGroup`, `chatName`
  and `groupId`, silently breaking any automation that filtered on
  `isGroup`. The catch block now infers `isGroup` from the JID suffix
  (`@g.us`) instead of assuming `false` — a group message can also hit
  this path if the author uses a LID.
- **`resolveChatId` now validates numbers via `getNumberId()`** instead
  of blindly appending `@c.us`. If the number isn't registered on
  WhatsApp, this is now detected and logged here instead of failing
  silently later in `sendMessage`.

### Added
- **In-memory LID → phone cache (`lidPhoneCache`)**, populated from
  multiple sources and consulted by `resolveChatId` before sending, so
  the bridge can resolve known LIDs on its own without depending on
  external state.
- **LID resolution cascade** on incoming messages: internal cache →
  `getContactLidAndPhone()` (official API) → `getContactById().number`
  (fallback). Result is exposed as `payloadData.resolvedPhone` and
  cached for future messages.
- **`contact_changed` listener**: updates the LID cache in real time
  when WhatsApp notifies an identity change, without waiting for a
  message from that contact. Also broadcasts a `contact_changed` event
  to connected clients.
- **Incoming media forwarding**: when a message contains an image
  (`type: 'image'`) or voice note (`type: 'ptt'` / `'audio'`), it's
  downloaded via `msg.downloadMedia()` and attached to the payload as
  `payloadData.media = { mimetype, data (base64), filename }`. Capped
  at 15MB per file to avoid saturating the WebSocket connection.

### Context
This release responds to WhatsApp's global rollout of usernames
(June–July 2026), which exposed contacts behind LIDs instead of phone
numbers with increasing frequency, breaking chat/group identification
in automations that depended on phone-number-based logic.

## 2.0.0

Initial fork baseline.
