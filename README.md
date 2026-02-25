> **Disclaimer from underlying library [whatsapp-web.js](https://wwebjs.dev/)**
> This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or its affiliates. The official WhatsApp website can be found at [whatsapp](https://www.whatsapp.com). "WhatsApp" as well as related names, marks, emblems and images are registered trademarks of their respective owners. Also it is not guaranteed you will not be blocked by using this method. WhatsApp does not allow bots or unofficial clients on their platform, so this shouldn't be considered totally safe. For any businesses looking to integrate with WhatsApp for critical applications, we highly recommend using officially supported methods, such as Twilio's solution or other alternatives. You might also consider the [official API](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview).

# Home Assistant WhatsApp Integration

A custom integration to send and receive WhatsApp messages in Home Assistant naturally. It uses a local [whatsapp-web.js](https://wwebjs.dev/) bridge running in Docker.

## Features
- **Send Messages**: Use the `whatsapp.send_message` service in HA.
- **Group Messaging**: Send messages to WhatsApp groups by name.
- **Receive Messages**: Trigger automations when messages arrive.
- **Easy Auth**: Scan a QR code in Home Assistant to link your account.

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
  number: "40741234567" # OR group: "Group Name"
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

### Group Message Trigger
To trigger an automation from a group message, use `from_group` with the exact group name:

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

## Installation

### 1. Run the Bridge

#### Option A: Home Assistant Add-on (Recommended for HA OS)
1.  Go to **Settings > Add-ons > Add-on Store**.
2.  Click the **dots (top-right) > Repositories**.
3.  Add this repository URL: `https://github.com/raulpetruta/ha-wa-bridge`
4.  Reload the store and install **WhatsApp Bridge**.
5.  Start the Add-on.

#### Option B: Docker (For Container/Core users)
This project requires a small bridge service. Create a `docker-compose.yaml` file with the following content:

```yaml
services:
  ha-wa-bridge:
    image: ghcr.io/raulpetruta/ha-wa-bridge:latest
    container_name: ha-wa-bridge
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ${CONFIG_DIR}/ha-wa-bridge/.wa_auth:/usr/src/app/.wwebjs_auth
      - ${CONFIG_DIR}/ha-wa-bridge/.wa_cache:/usr/src/app/.wwebjs_cache
    environment:
      - PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
      - PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

Then run:
```bash
docker-compose up -d
```

### 2. Install the Integration

#### Option A: HACS (Recommended)
1.  Make sure [HACS](https://hacs.xyz/) is installed.
2.  Go to HACS > Integrations > Top-right menu > **Custom repositories**.
3.  Add `https://github.com/raulpetruta/ha-wa-bridge` as an **Integration**.
4.  Click **Download**.
5.  Restart Home Assistant.

#### Option B: Manual Installation
1.  Copy the `custom_components/whatsapp` folder to your Home Assistant `config/custom_components/` directory.
2.  Restart Home Assistant.

## Configuration

### Add-on Configuration
If you are using the Home Assistant Add-on, you can configure the following options in the add-on configuration tab:
- **`detect_own_messages`**: Set to `true` to allow the bridge to detect and broadcast messages sent by your own authenticated WhatsApp account (e.g., messages sent from WhatsApp Web, your phone, or voice assistants like Ray-Ban Meta glasses). **Note: This feature only works for messages sent in WhatsApp groups.** Default is `false`.

### Docker Compose Configuration
If you are using Docker Compose, you can enable this feature using an environment variable (**Note: This feature only works for messages sent in WhatsApp groups**):
```yaml
    environment:
      - DETECT_OWN_MESSAGES=true
```

### Integration Setup

1.  Go to **Settings > Devices & Services**.
2.  Click **Add Integration** and search for **WhatsApp**.
4.  **Click Submit**. The integration will be added immediately.
5.  Check your **Home Assistant Notifications** (bell icon) for the QR code.
6.  **Scan the QR Code** with your WhatsApp mobile app (Linked Devices).

## Credits 
Powered by [whatsapp-web.js](https://wwebjs.dev/).

## Supporters 🙏

Thanks to these legends for their support:

- @louis_remi
- Pattio
- Ni3k

## Buy me a coffee
- [Buy Me a Coffee](https://buymeacoffee.com/raulpetruta)

## License
[MIT](LICENSE)
