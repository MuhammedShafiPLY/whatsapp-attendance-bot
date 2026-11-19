# 📱 Zaynlo WhatsApp Attendance & Leave Management Bot

> **An intelligent multi-session attendance and leave management bot for WhatsApp, powered by `whatsapp-web.js`, Google Gemini AI, and MongoDB.**

---

## 🚀 Features

- **Multi-Session Work Tracking:** Supports multiple punch-in / punch-out sessions per day (e.g. lunch breaks, errands) with precise session and cumulative daily duration calculations.
- **AI Intent Classification:** Uses Google Gemini (`gemini-1.5-flash`) with instant regex fallback to understand natural employee messages (`Sign in`, `Sign out`, `Leave`, `Late`).
- **Privacy LID Mapping:** Automatically resolves WhatsApp multi-device privacy identifiers (`@lid`) to actual team mobile numbers.
- **MongoDB Persistence:** Stores structured attendance records indexed by employee and date.
- **Docker & Cloud Ready:** Pre-configured `Dockerfile` and built-in HTTP health check server for instant deployment on **Render**, **Railway**, or **VPS**.

---

## 🛠️ Environment Variables

Create a `.env` file in the root directory (based on `.env.example`):

```env
# Google Gemini API Key (from https://aistudio.google.com/)
GEMINI_API_KEY="your-gemini-api-key"

# MongoDB Connection String
MONGODB_URI="mongodb+srv://<user>:<password>@cluster0.mongodb.net/attendance_db"

# Target WhatsApp Group Title
GROUP_NAME="Attendance Zaynlo 9:30 - 5:30🤝🏻"

# Timezone
TIMEZONE="Asia/Kolkata"
```

---

## 💻 Local Quickstart

```bash
# Install dependencies
npm install

# Run the bot
npm start
```

Scan the terminal QR code using WhatsApp on your phone (**Linked Devices** -> **Link a Device**).

---

## 🌐 Deploying to Render.com

1. Push this repository to GitHub.
2. Go to [Render.com Dashboard](https://dashboard.render.com/) and click **New +** -> **Web Service**.
3. Select your GitHub repository.
4. Set the **Runtime** to **Docker** (Render will automatically detect the `Dockerfile`).
5. Under **Environment Variables**, add:
   - `GEMINI_API_KEY`
   - `MONGODB_URI`
   - `GROUP_NAME`
   - `TIMEZONE` (set to `Asia/Kolkata`)
6. Click **Deploy Web Service**.
7. In the Render service **Logs**, scan the QR code using WhatsApp on your phone.

---

## 📜 License

MIT License. Designed for **Zaynlo**.
