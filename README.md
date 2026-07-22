> **Disclaimer from underlying library [whatsapp-web.js](https://wwebjs.dev/)**
> This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or its affiliates. The official WhatsApp website can be found at [whatsapp](https://www.whatsapp.com). "WhatsApp" as well as related names, marks, emblems and images are registered trademarks of their respective owners. Also it is not guaranteed you will not be blocked by using this method. WhatsApp does not allow bots or unofficial clients on their platform, so this shouldn't be considered totally safe. For any businesses looking to integrate with WhatsApp for critical applications, we highly recommend using officially supported methods, such as Twilio's solution or other alternatives. You might also consider the [official API](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview).

# Home Assistant WhatsApp Integration

A custom integration to send and receive WhatsApp messages in Home Assistant naturally. It uses a local [whatsapp-web.js](https://wwebjs.dev/) bridge running in Docker.

> **This fork** adds robustness for WhatsApp's **usernames/LID rollout** (June–July 2026), which causes contacts to appear behind an opaque LID instead of a phone number in many internal library calls (`getChat`, `downloadMedia`, etc.), plus incoming **media handling** (images, voice notes, stickers) with a manual decrypt fallback for when the library's own download path is affected by the LID bug. See [Fork-specific features](#fork-specific-features) below.

## Features
- **Send Messages**: Use the `whatsapp.send_message` service in HA.
- **Group Messaging**: Send messages to WhatsApp groups by name or by group ID.
- **Group ID Support**: Target groups by their stable ID instead of name — automations won't break when a group is renamed.
- **Get Groups**: Retrieve all WhatsApp groups with their IDs using the `whatsapp.get_groups` service.
- **Set Group Subject**: Dynamically update a group's name using the `whatsapp.set_group_subject` service — perfect for automating group names based on schedules or sensor values.
- **Set Group Picture**: Update a group's picture using the `whatsapp.set_group_picture` service.
- **Receive Messages**: Trigger automations when messages arrive (including WhatsApp Community channels).
- **Receive Media**: Incoming images, voice notes, and stickers are downloaded (or decrypted manually as a fallback) and saved to a private local folder, with the path forwarded in the event — no public exposure, no giant payloads in the HA event bus.
- **Reply/Quote Context**: When a message is a reply to another, the quoted message's text is included in the event so automations can understand the full context.
- **LID Resolution**: Incoming messages from contacts using WhatsApp usernames (LID) are resolved to their real phone number when possible, exposed as `resolvedPhone` in the event.
- **Send Events**: Send WhatsApp calendar events with name, location, and time using the `whatsapp.send_event` service.
- **Receive Filtering**: Disable incoming messages entirely or restrict to specific groups to save resources.
- **Easy Auth**: Scan a QR code in Home Assistant to link your account.

## Fork-specific features

### LID (username) robustness
WhatsApp's usernames feature hides a contact's real phone number behind an opaque LID (`xxxxxxxxxxx@lid`) in many places. `whatsapp-web.js` has several open bugs where internal calls (`msg.getChat()`, `msg.downloadMedia()`) throw or hang for LID-based senders. This fork adds:
- Safe fallbacks when `getChat()` fails, inferring `isGroup`/`groupId` from the JID itself instead of guessing incorrectly.
- An 8-second timeout around `getChat()` and `downloadMedia()` so a hang never blocks message processing indefinitely.
- LID → phone resolution cascade: in-memory cache → official `getContactLidAndPhone()` API → `getContactById().number` fallback. Result exposed as `resolvedPhone` on incoming message events.
- A `contact_changed` listener that keeps the LID cache updated in real time (with a guard against accidentally caching the bot's own number).
- Filtering of internal WhatsApp system/notification messages (`notification_template`, etc.) that would otherwise be forwarded as if they were real user messages.

### Resolving LIDs proactively
You don't have to wait for a contact to message you first. Send a `resolve_lids` command directly over the bridge's WebSocket (port 3000) with a list of phone numbers, and get back their LIDs (if they have one) using WhatsApp's own `getContactLidAndPhone()` API:

```json
{ "type": "resolve_lids", "phones": ["40741234567", "49123456789"] }
```

Response:
```json
{ "type": "resolve_lids_response", "data": [{ "pn": "...", "lid": "..." }] }
```

### Incoming media (images, voice notes, stickers)
When a message contains an image, voice note, or sticker, the bridge:
1. Tries `msg.downloadMedia()` (with an 8s timeout).
2. If that fails (common with LID senders), decrypts the file manually using the `mediaKey` + `directPath`/`deprecatedMms3Url` WhatsApp already includes in the message — bypassing the library's broken internal path entirely, at full quality.
3. If both fail, falls back to the low-res thumbnail sometimes embedded in the message.

The resulting file is saved to a **private** local folder (configurable via `media_dir`, default `/config/whatsapp/media`) and the event includes `mediaPath` + `mediaMimetype` (short strings) instead of embedding the full base64 payload — avoiding both Home Assistant's Jinja template size limit and bloating the event bus with large payloads.

### Reply/quote context
If an incoming message is a reply to a previous one, `quotedBody` (the text of the original message) is included in the event, so your automations/LLM prompts can understand what's being replied to without extra API calls.

## Usage

### Sending a Messsage
You can send messages to any number using the service:

```yaml
service: whatsapp.send_message
data:
  number: "40741234567" # Country code + Number (no "+" symbol) 
  message: "Hello from Home Assistant! 🏠"
```

### Sending to a Group
You can send messages to a group by its exact name:

```yaml
service: whatsapp.send_message
data:
  group: "Family Group" # Exact name of the group
  message: "Dinner is ready! 🍽️"
```

> **Note:** sending by group *name* requires an internal `getChats()` call to look up the group. If your account has contacts affected by the LID bug, this call can fail entirely. Prefer **Sending to a Group by ID** below whenever possible — it's also faster since it skips the lookup.

### Sending to a Group by ID
You can send messages to a group using its stable ID. This is recommended for automations since the ID doesn't change when the group is renamed, and it avoids the `getChats()` LID issue entirely. Use the `whatsapp.get_groups` service to find group IDs; or check the add on logs while sending / receiving a message for a group to get the ID

```yaml
service: whatsapp.send_message
data:
  group_id: "120363012345678901" # Group ID (use get_groups to find this)
  message: "Dinner is ready! 🍽️"
```

### Retrieving Group IDs
Use the `whatsapp.get_groups` service to retrieve all your WhatsApp groups with their IDs. The results are fired as a `whatsapp_groups_received` event.

```yaml
service: whatsapp.get_groups
```

You can listen for the result with an automation:

```yaml
trigger:
  - platform: event
    event_type: whatsapp_groups_received
action:
  - service: persistent_notification.create
    data:
      title: "WhatsApp Groups"
      message: >
        {% for group in trigger.event.data.groups %}
        - {{ group.name }}: {{ group.id }}
        {% endfor %}
```

### Setting a Group Subject (Name)
You can dynamically update a group's name using the `whatsapp.set_group_subject` service. This is useful for automating group names based on schedules or template sensors. Requires admin permissions in the group.

```yaml
service: whatsapp.set_group_subject
data:
  group_id: "120363012345678901" # Group ID (use get_groups to find this)
  subject: "Weekly Meeting - Monday 7PM"
```

### Setting a Group Picture
You can update a group's picture using the `whatsapp.set_group_picture` service. Supports both URL and local path. Requires admin permissions in the group.

#### Using a URL
```yaml
service: whatsapp.set_group_picture
data:
  group_id: "120363012345678901" # Group ID (use get_groups to find this)
  media_url: "https://example.com/group-photo.jpg"
```

#### Using a Local File
```yaml
service: whatsapp.set_group_picture
data:
  group_id: "120363012345678901" # Group ID (use get_groups to find this)
  media_path: "www/group-photo.jpg"
```

## Sending Broadcast Messages
You can send messages to multiple targets using the service:

```yaml
service: whatsapp.send_broadcast
data:
  message: "Hello everyone! This is a broadcast."
  targets:
    - "Family Group"      # Group name
    - "40741234567"       # Phone number
```

### Sending Polls
You can send polls using the `whatsapp.send_poll` service:

```yaml
service: whatsapp.send_poll
data:
  message: "What should we have for dinner?"
  options:
    - "Pizza"
    - "Sushi"
    - "Burgers"
  allow_multiple_answers: true
  number: "40741234567" # OR group: "Group Name" OR group_id: "120363012345678901"
```

### Sending Events
You can send WhatsApp calendar events using the `whatsapp.send_event` service. Events include a name, start time, and optional description, location, end time, and call link.

```yaml
service: whatsapp.send_event
data:
  number: "40741234567" # OR group: "Group Name" OR group_id: "120363012345678901"
  name: "Weekly Team Meeting"
  description: "Discuss project updates and next steps"
  location: "Conference Room A" # OR meeting link https://teams.microsoft.com/l/meetup-join/
  start_time: "2026-06-15T14:00:00"
  end_time: "2026-06-15T15:00:00"
  call_type: "video" # Optional: video, voice, or none
```

#### Minimal Example
Only `name` and `start_time` are required:

```yaml
service: whatsapp.send_event
data:
  number: "40741234567"
  name: "Dentist Appointment"
  start_time: "2026-06-20T10:30:00"
```

### Automation Trigger for Polls
Trigger actions when a user votes on a poll using the `whatsapp_poll_vote_received` event.

The event contains:
- `voter`: The phone number of the voter (e.g. `40741234567`)
- `selectedOptions`: An array of the options selected
- `group_id`: The ID of the group if the poll was in a group, otherwise null

```yaml
trigger:
  - platform: event
    event_type: whatsapp_poll_vote_received
    # Optional: trigger only for a specific voter
    # event_data:
    #   voter: "40741234567" 
action:
  - service: notify.persistent_notification
    data:
      message: "Received a vote from {{ trigger.event.data.voter }}! Selected options: {{ trigger.event.data.selectedOptions | map(attribute='name') | list | join(', ') }}"
```

### Sending Media
You can send images or files using either a URL (`media_url`) or a local path (`media_path`).

#### Using a URL
```yaml
service: whatsapp.send_message
data:
  number: "40741234567"
  message: "Check this out!"
  media_url: "https://www.home-assistant.io/images/favicon.ico"
```

#### Using a Local File
Ensure the path is accessible by Home Assistant (e.g., in `config/www`).
```yaml
service: whatsapp.send_broadcast
data:
  targets: ["Family Group", "40741234567"]
  message: "Security Snapshot"
  media_path: "/config/www/camera_snapshot.jpg"
```

### Automation Trigger
Trigger actions when a specific message is received:

```yaml
trigger:
  - platform: whatsapp
    from_number: "40741234567"
    contains_text: "Turn on lights" # Optional
action:
  - service: light.turn_on
    target:
      entity_id: light.living_room
```

### Receiving Media (images, voice notes, stickers)
Incoming messages that contain media will include `hasMedia: true`, `messageType` (`image` | `ptt` | `audio` | `sticker`), `mediaPath` (local file path), and `mediaMimetype` in the trigger data. Read the file directly from disk in your automation/script — don't try to pass `mediaPath`'s *contents* through a Jinja template (only the *path* is a small string, the file itself can be large).

```yaml
trigger:
  - platform: event
    event_type: whatsapp_message_received
condition:
  - condition: template
    value_template: "{{ trigger.event.data.hasMedia == true and trigger.event.data.mediaPath is defined }}"
action:
  - service: shell_command.process_incoming_media
    data:
      ruta_imagen: "{{ trigger.event.data.mediaPath }}"
      mimetype: "{{ trigger.event.data.mediaMimetype }}"
```

The bridge doesn't delete files on its own — have your script delete the file itself once it's done reading it, so photos don't accumulate on disk.

### Group Message Trigger
Trigger actions when a message is received in a specific group.

```yaml
trigger:
  - platform: whatsapp
    from_group: "Family Group"
    contains_text: "Dinner" # Optional
action:
  - service: notify.persistent_notification
    data:
      message: "Dinner time!"
```

### Group Message Trigger by ID
For more stable automations, use `from_group_id` instead of `from_group`. The group ID remains the same even if the group name changes:

```yaml
trigger:
  - platform: whatsapp
    from_group_id: "120363012345678901"
    contains_text: "Dinner" # Optional
action:
  - service: notify.persistent_notification
    data:
      message: "Dinner time!"
```

### Channel Message Trigger
WhatsApp Community channels are treated as groups internally. You can trigger automations from channel messages using `from_group` or `from_group_id`, just like regular groups:

```yaml
trigger:
  - platform: whatsapp
    from_group: "Announcements" # Exact channel name
    contains_text: "update" # Optional
action:
  - service: notify.persistent_notification
    data:
      message: "New channel update received!"
```

For more stable automations, use `from_group_id` with the channel's numeric ID (without `@g.us`). The ID remains the same even if the channel is renamed:

```yaml
trigger:
  - platform: whatsapp
    from_group_id: "120363428200052636" # Channel ID (use get_groups or check bridge logs)
    contains_text: "update" # Optional
action:
  - service: notify.persistent_notification
    data:
      message: "New channel update received!"
```

## Installation

### 1. Run the Bridge

#### Option A: Home Assistant Add-on (Recommended for HA OS)
1.  Go to **Settings > Add-ons > Add-on Store**.
2.  Click the **dots (top-right) > Repositories**.
3.  Add this repository URL: `https://github.com/cyoulabel/ha-wa-bridge`
4.  Reload the store and install **WhatsApp Bridge**.
5.  Start the Add-on.

> ⚠️ Make sure you're installing from **this fork's repository**, not the upstream one — the upstream version does not include the LID/media fixes described above. If you already have the add-on installed from the upstream repo, remove that repository from **Settings > Add-ons > Add-on Store > ⋮ > Repositories** first, add this fork's URL instead, then reinstall.

#### Option B: Docker (For Container/Core users)
This project requires a small bridge service. Create a `docker-compose.yaml` file with the following content:

```yaml
services:
  ha-wa-bridge:
    build: ./wa-bridge
    container_name: ha-wa-bridge
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ${CONFIG_DIR}/ha-wa-bridge/.wa_auth:/usr/src/app/.wwebjs_auth
      - ${CONFIG_DIR}/ha-wa-bridge/.wa_cache:/usr/src/app/.wwebjs_cache
      - ${CONFIG_DIR}/whatsapp/media:/config/whatsapp/media
    environment:
      - PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
      - PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

      # Forward messages you send yourself (groups only)
      - DETECT_OWN_MESSAGES=false

      # Incoming message mode: all | disabled | groups_only | numbers_only
      # - all          → forward everything (default)
      # - disabled     → send-only mode, no incoming messages processed
      # - groups_only  → group chats only, ignore 1-to-1 messages
      # - numbers_only → direct messages from ALLOWED_NUMBERS only
      - INCOMING_MESSAGES_MODE=all

      # Logging level for incoming messages: FULL | COMPACT | NONE
      # - FULL    → log entire message payload (default)
      # - COMPACT → log only sender and message type
      # - NONE    → disable logging for incoming messages
      - INCOMING_MESSAGE_LOG_LEVEL=FULL

      # Where incoming media (images/voice notes/stickers) is saved.
      # Keep this OUTSIDE of any publicly-served path (e.g. not under
      # a web-exposed "www" folder) — media isn't meant to be public.
      - MEDIA_DIR=/config/whatsapp/media

      # Comma-separated group names — only these groups are forwarded (optional)
      # - ALLOWED_GROUPS=Family Group,Work Team

      # Comma-separated phone numbers without '+' — only these numbers are forwarded (optional)
      # Required for numbers_only mode
      # - ALLOWED_NUMBERS=40741234567,49123456789
```

Then run:
```bash
docker-compose up -d
```

### 2. Install the Integration

#### Option A: HACS (Recommended)
1.  Make sure [HACS](https://hacs.xyz/) is installed.
2.  Go to HACS > Integrations > Top-right menu > **Custom repositories**.
3.  Add `https://github.com/cyoulabel/ha-wa-bridge` as an **Integration**.
4.  Click **Download**.
5.  Restart Home Assistant.

#### Option B: Manual Installation
1.  Copy the `custom_components/whatsapp` folder to your Home Assistant `config/custom_components/` directory.
2.  Restart Home Assistant.

## Configuration

### Add-on Configuration
If you are using the Home Assistant Add-on, you can configure the following options in the add-on configuration tab:

- **`detect_own_messages`**: Set to `true` to forward messages sent by your own account (e.g., from WhatsApp Web or your phone). Works for group messages only. Default: `false`.

- **`incoming_messages_mode`**: Controls which incoming messages are forwarded to Home Assistant. Accepted values:
  - `all` *(default)* – all messages are forwarded, same as previous behaviour.
  - `disabled` – the message listener is **never registered**; the container uses minimal resources and is still fully capable of sending messages.
  - `groups_only` – only messages from group chats are forwarded; 1-to-1 conversations are ignored.
  - `numbers_only` – only direct messages from phone numbers listed in `allowed_numbers` are forwarded; group messages are ignored.

- **`incoming_message_log_level`**: Controls the amount of detail logged in the Add-on logs when receiving messages or poll votes. Accepted values:
  - `FULL` *(default)* – logs the entire raw message payload.
  - `COMPACT` – logs only basic info like sender identification and message type ("Message received from X"). Message bodies and selected options are omitted.
  - `NONE` – disables all logging for incoming messages. This is the most private option.

- **`allowed_groups`**: An optional list of group names. When set, **only** messages from groups whose name exactly matches one of the entries are forwarded. Useful if you only care about a single group. Example:
  ```yaml
  allowed_groups:
    - "Family Group"
    - "Work Team"
  ```
  Leave empty (default) to apply no group-name filter.

- **`allowed_numbers`**: An optional list of phone numbers (international format, no `+`). When set, **only** messages from those numbers are forwarded. Required when using `numbers_only` mode; also works as an extra filter in `all` mode. Example:
  ```yaml
  allowed_numbers:
    - "40741234567"
    - "49123456789"
  ```
  Leave empty (default) to apply no number filter.

- **`media_dir`**: Local folder where incoming images, voice notes, and stickers are saved before your automations process them. Default: `/config/whatsapp/media`. Keep this outside any publicly web-served path — files here are meant to be read locally by your own scripts, never exposed over the internet. The bridge deletes nothing on its own; have your automation/script delete the file once it's done reading it.

### Docker Compose Configuration
All options are also available as environment variables:
```yaml
    environment:
      - DETECT_OWN_MESSAGES=true
      # Options: all | disabled | groups_only | numbers_only
      - INCOMING_MESSAGES_MODE=disabled
      # Options: FULL | COMPACT | NONE
      - INCOMING_MESSAGE_LOG_LEVEL=FULL
      # Comma-separated group names (optional)
      - ALLOWED_GROUPS=Family Group,Work Team
      # Comma-separated phone numbers without '+' (optional)
      - ALLOWED_NUMBERS=40741234567,49123456789
      # Local folder for incoming media (optional)
      - MEDIA_DIR=/config/whatsapp/media
```

### Integration Setup

1.  Go to **Settings > Devices & Services**.
2.  Click **Add Integration** and search for **WhatsApp**.
4.  **Click Submit**. The integration will be added immediately.
5.  Check your **Home Assistant Notifications** (bell icon) for the QR code.
6.  **Scan the QR Code** with your WhatsApp mobile app (Linked Devices).

## Troubleshooting

### Messages from some contacts aren't being recognized / automations conditioned on `isGroup` don't fire
This is almost always the LID (username) issue described above. Make sure you're running the latest version of this fork — check the [Changelog](CHANGELOG.md) for the specific fixes included in each release.

### "Template output exceeded maximum size" error in an automation
Don't pass `mediaPath`'s file *contents* through a Jinja template — only the *path* (a short string) should go through templating. Read the file directly from disk in your script using the path.

### Sending by group name fails with a `getChats` error
Switch to `group_id` instead of `group` — see [Sending to a Group by ID](#sending-to-a-group-by-id) above. Sending by name requires enumerating all chats, which can fail if any contact in your chat list is affected by the LID bug.

## Credits 
Powered by [whatsapp-web.js](https://wwebjs.dev/). This fork builds on the excellent work of [raulpetruta/ha-wa-bridge](https://github.com/raulpetruta/ha-wa-bridge).

## License
[MIT](LICENSE)
