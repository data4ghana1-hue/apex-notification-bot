# Apex Prime WhatsApp Notification Bot 🚀

Dedicated 24/7 cloud notification service for dispatching automated WhatsApp customer notifications for Apex Prime.

## Features
- **24/7 Automated Notification Delivery**: Instant order status alerts, wallet top-up confirmations, and customer updates.
- **Dual Pairing Options**: Connect easily via **QR Code** or **8-Digit Phone Pairing Code**.
- **Web Dashboard**: Live status monitoring, QR code viewer, manual test message sender, and unlink controls.
- **HTTP API**: Clean REST endpoint `POST /api/send-message`.

## Deployment to Render.com
1. Push this repository to GitHub.
2. Create a new **Web Service** on [Render.com](https://dashboard.render.com).
3. Connect this GitHub repository.
4. Set **Build Command**: `npm install`
5. Set **Start Command**: `node index.js`
6. Deploy! Once live, open your Render URL to scan the QR code or link via phone number.

## Connecting to Apex Prime Website
In `config.php` on your website, set:
```php
define('WHATSAPP_NOTIFICATION_BOT_URL', 'https://your-bot-name.onrender.com');
```
