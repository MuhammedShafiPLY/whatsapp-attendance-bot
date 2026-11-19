/**
 * Advanced WhatsApp Attendance & Leave Management Bot for "Huelux"
 * Supports Multiple Sign-In / Sign-Out Sessions per day (e.g. lunch/errand breaks)
 * with precise duration calculation for each session and daily total worked hours.
 * Powered by whatsapp-web.js, Google Gemini AI, and MongoDB.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Attendance = require('./models/Attendance');

// ==========================================
// Official Team Members & Privacy LID Mapping
// ==========================================
// Maps WhatsApp phone numbers and privacy LIDs to official team member names
const teamMembers = {
  // Muhammed Shafi PP
  '917902817585@c.us': 'Muhammed Shafi PP',
  '917902817585': 'Muhammed Shafi PP',
  '102340614971456': 'Muhammed Shafi PP',
  '102340614971456@lid': 'Muhammed Shafi PP',

  // Muhammed Minhaj.K
  '919562877632@c.us': 'Muhammed Minhaj.K',
  '919562877632': 'Muhammed Minhaj.K',

  // Thasneem TK
  '918590060429@c.us': 'Thasneem TK',
  '918590060429': 'Thasneem TK',

  // Zaynlo Host Admin
  '919526299568@c.us': 'Zaynlo Admin',
  '919526299568': 'Zaynlo Admin',
};

// Maps WhatsApp Multi-Device privacy LIDs to the real mobile number
// so MongoDB always stores the actual phone number
const lidToPhoneMap = {
  '102340614971456': '917902817585',
};

// Known exact group ID discovered from WhatsApp Web
const KNOWN_TARGET_GROUP_ID = '120363431289307868@g.us';

// ==========================================
// 1. Environment Variables & Configuration
// ==========================================
const { GEMINI_API_KEY, MONGODB_URI, GROUP_NAME, TIMEZONE, PAIR_WITH_PHONE_NUMBER } = process.env;
const APP_TIMEZONE = TIMEZONE || 'Asia/Kolkata';

if (!GEMINI_API_KEY || !MONGODB_URI || !GROUP_NAME) {
  console.error('❌ Missing required environment variables in .env!');
  console.error('Required: GEMINI_API_KEY, MONGODB_URI, GROUP_NAME');
  process.exit(1);
}

// ==========================================
// 2. Date & Time Helper Functions
// ==========================================

/**
 * Returns today's date in "YYYY-MM-DD" format in configured timezone.
 */
function getTodayDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(date);
}

/**
 * Formats a Date object into readable 12-hour string (e.g. "10:16 AM").
 */
function formatDisplayTime(date = new Date()) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: APP_TIMEZONE,
  });
}

/**
 * Parses user-supplied or AI-extracted time string (e.g. "10:15", "5:32", "11:26 am", "1:58 pm", "2:30 pm")
 * into a Date object for today.
 */
function parseTimeToDate(timeStr, intent, fallbackDate = new Date()) {
  if (!timeStr || typeof timeStr !== 'string') return fallbackDate;

  const match = timeStr.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
  if (!match) return fallbackDate;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3] ? match[3].toUpperCase() : null;

  if (period === 'PM' && hours < 12) {
    hours += 12;
  } else if (period === 'AM' && hours === 12) {
    hours = 0;
  } else if (!period) {
    // Infer PM for afternoon/evening times between 1:00 and 7:59
    if (hours >= 1 && hours <= 7) {
      hours += 12;
    }
  }

  const d = new Date(fallbackDate);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Formats duration in minutes to readable "X hours Y minutes" string.
 */
function formatMinutesToHoursAndMinutes(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return '0 minutes';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  if (minutes === 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  return `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

// ==========================================
// 3. Gemini AI & Fallback Pattern Classifier
// ==========================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.1,
  },
});

/**
 * Fast fallback pattern classifier when Gemini AI is offline, invalid key, or slow.
 */
function fallbackClassify(text) {
  const lower = text.toLowerCase().trim();

  // Extract explicit time if present in message (e.g. "10:15", "5:32", "11:26 am", "1:58 pm")
  const timeMatch = text.match(/(\d{1,2}[:.]\d{2}\s*(?:am|pm)?)/i);
  const time = timeMatch ? timeMatch[1].trim() : null;

  // 1. Late detection
  if (/\b(late|running late|delayed|delay|traffic|reach (?:in|by)|stuck in)\b/i.test(lower)) {
    const noteMatch = text.match(/(?:due to|because of|reason\s*:?)\s*([^\n\r]+)/i);
    const note = noteMatch
      ? noteMatch[1].trim()
      : text.replace(/\b(i am|will be|running|late|today|sorry)\b/gi, '').trim() || text;
    return { intent: 'LATE', time, note };
  }

  // 2. Leave detection
  if (/\b(leave|sick|fever|absent|not coming|day off|emergency|half day|vacation|hospital)\b/i.test(lower)) {
    const noteMatch = text.match(/(?:due to|because of|reason\s*:?)\s*([^\n\r]+)/i);
    const note = noteMatch
      ? noteMatch[1].trim()
      : text.replace(/^(i am on|taking|applying for|on leave|leave|today|on)\s+/gi, '').trim() || text;
    return { intent: 'LEAVE', time, note };
  }

  // 3. Sign Out detection
  if (
    /\b(sign\s*out|signout|logged\s*out|log\s*out|signing\s*off|sign\s*off|done for today|leaving|checkout|check\s*out|bye team|heading home)\b/i.test(
      lower
    )
  ) {
    let note = text.replace(
      /^(?:time\s*[:=\-]?\s*)?(?:sign\s*out|signout|log\s*out|logged\s*out)\s*(?:\d{1,2}[:.]\d{2}\s*(?:am|pm)?)?/gi,
      ''
    ).trim();
    note = note.replace(/^[:,\-\s]+/, '').trim() || null;
    return { intent: 'SIGN_OUT', time, note };
  }

  // 4. Sign In detection
  if (
    /\b(sign\s*in|signin|present|punch\s*in|log\s*in|logged\s*in|checking\s*in|check\s*in|starting work|reached|here|back|returned)\b/i.test(
      lower
    ) ||
    lower === 'p'
  ) {
    let note = text.replace(
      /^(?:time\s*[:=\-]?\s*)?(?:sign\s*in|signin|punch\s*in|present)\s*(?:\d{1,2}[:.]\d{2}\s*(?:am|pm)?)?/gi,
      ''
    ).trim();
    note = note.replace(/^[:,\-\s]+/, '').trim() || null;
    return { intent: 'SIGN_IN', time, note };
  }

  return { intent: 'OTHER', time: null, note: null };
}

/**
 * Classifies an incoming message into SIGN_IN, SIGN_OUT, LEAVE, LATE, or OTHER using Gemini AI.
 * Wrapped with a strict 3.5s timeout so a slow or hanging API call immediately falls back.
 */
async function classifyMessageWithGemini(text) {
  const prompt = `Analyze this attendance message. Classify the intent as exactly one of: 'SIGN_IN', 'SIGN_OUT', 'LEAVE', 'LATE', or 'OTHER'.

If the user explicitly typed a time, extract it in 'time'.

If they added extra text, status updates, or reasons (e.g., 'completed UI', 'going to hospital', 'traffic'), extract it in 'note'.

Return ONLY a valid JSON object: { "intent": "...", "time": "...", "note": "..." }.

Message to analyze:
"${text}"
`;

  try {
    const geminiPromise = geminiModel.generateContent(prompt).then((res) => res.response.text());
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gemini API timeout')), 3500)
    );

    const responseText = await Promise.race([geminiPromise, timeoutPromise]);
    const cleaned = responseText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    let intent = parsed.intent ? parsed.intent.toUpperCase() : 'OTHER';
    if (intent === 'PRESENT' || intent === 'PUNCH_IN') intent = 'SIGN_IN';
    if (intent === 'PUNCH_OUT') intent = 'SIGN_OUT';

    const validIntents = ['SIGN_IN', 'SIGN_OUT', 'LEAVE', 'LATE', 'OTHER'];
    if (!validIntents.includes(intent)) {
      intent = 'OTHER';
    }

    const time = parsed.time ? String(parsed.time).trim() : null;
    const note = parsed.note ? String(parsed.note).trim() : null;

    return { intent, time, note };
  } catch (error) {
    console.warn(`⚠️ Gemini AI notice (${error.message}). Using instant fallback classifier.`);
    return fallbackClassify(text);
  }
}

// ==========================================
// 4. MongoDB Database Operations (Multi-Session)
// ==========================================
async function connectToDatabase() {
  try {
    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ MongoDB connected successfully.');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
}

/**
 * Handles Sign-In with Multiple Sessions:
 * If the user already signed out earlier today (e.g. at 12:00 PM) and returns (at 2:00 PM),
 * this appends a new punch session (Session #2) to today's record.
 */
async function handleSignIn({ name, phoneNumber, timeStr, note }) {
  const todayStr = getTodayDateString();
  const signInDate = parseTimeToDate(timeStr, 'SIGN_IN', new Date());
  const signInTimeFormatted = formatDisplayTime(signInDate);

  let record = await Attendance.findOne({
    phoneNumber,
    date: todayStr,
  });

  let sessionNumber = 1;
  let isNewSession = true;

  if (!record) {
    // First sign-in of the day
    const firstSession = {
      sessionNumber: 1,
      signInTime: signInDate,
      signInTimeStr: signInTimeFormatted,
      signOutTime: null,
      signOutTimeStr: null,
      durationMinutes: 0,
      durationStr: null,
      note: note || null,
    };

    record = await Attendance.create({
      name,
      phoneNumber,
      date: todayStr,
      sessions: [firstSession],
      firstSignInTime: signInDate,
      firstSignInTimeStr: signInTimeFormatted,
      signInTime: signInDate,
      status: 'Present',
      note: note || null,
    });

    sessionNumber = 1;
    isNewSession = true;
  } else {
    // Record already exists for today
    record.name = name;
    if (!record.sessions) record.sessions = [];

    const lastSession = record.sessions[record.sessions.length - 1];

    // If the last session was still open (no signOutTime), update that session's signInTime
    if (lastSession && !lastSession.signOutTime) {
      lastSession.signInTime = signInDate;
      lastSession.signInTimeStr = signInTimeFormatted;
      if (note) lastSession.note = note;
      sessionNumber = lastSession.sessionNumber;
      isNewSession = false;
    } else {
      // Previous session was signed out. Append a NEW session!
      sessionNumber = (lastSession?.sessionNumber || record.sessions.length) + 1;
      const newSession = {
        sessionNumber,
        signInTime: signInDate,
        signInTimeStr: signInTimeFormatted,
        signOutTime: null,
        signOutTimeStr: null,
        durationMinutes: 0,
        durationStr: null,
        note: note || null,
      };
      record.sessions.push(newSession);
      isNewSession = true;
    }

    record.status = 'Present';
    record.signInTime = signInDate;
    if (!record.firstSignInTime) {
      record.firstSignInTime = signInDate;
      record.firstSignInTimeStr = signInTimeFormatted;
    }
    if (note) record.note = note;

    await record.save();
  }

  console.log(
    `[DB] Recorded Sign-In for ${name} (${phoneNumber}) at ${signInTimeFormatted} (Session #${sessionNumber})`
  );

  return {
    record,
    formattedTime: signInTimeFormatted,
    sessionNumber,
    isNewSession,
  };
}

/**
 * Handles Sign-Out with Multi-Session Calculation:
 * Closes the active open session, calculates its duration, and sums up ALL sessions
 * worked throughout the entire day.
 */
async function handleSignOut({ name, phoneNumber, timeStr, note }) {
  const todayStr = getTodayDateString();
  const signOutDate = parseTimeToDate(timeStr, 'SIGN_OUT', new Date());
  const signOutTimeFormatted = formatDisplayTime(signOutDate);

  let record = await Attendance.findOne({
    phoneNumber,
    date: todayStr,
  });

  let thisSessionDurationFormatted = null;
  let totalHoursTodayFormatted = '0 minutes';
  let sessionNumber = 1;
  let hadOpenSession = false;

  if (!record) {
    // Signed out without any prior sign in
    const session = {
      sessionNumber: 1,
      signInTime: signOutDate,
      signInTimeStr: signOutTimeFormatted,
      signOutTime: signOutDate,
      signOutTimeStr: signOutTimeFormatted,
      durationMinutes: 0,
      durationStr: '0 minutes',
      note: note || null,
    };

    record = await Attendance.create({
      name,
      phoneNumber,
      date: todayStr,
      sessions: [session],
      lastSignOutTime: signOutDate,
      lastSignOutTimeStr: signOutTimeFormatted,
      signOutTime: signOutDate,
      totalMinutesWorked: 0,
      totalHours: '0 minutes',
      status: 'Signed-Out',
      note: note || null,
    });

    return {
      record,
      formattedTime: signOutTimeFormatted,
      sessionDuration: '0 minutes',
      totalHours: '0 minutes',
      sessionNumber: 1,
      completedSessionsCount: 1,
      hadOpenSession: false,
    };
  }

  record.name = name;
  if (!record.sessions) record.sessions = [];

  // Find the active open session (where signOutTime is null)
  let openSession = record.sessions.slice().reverse().find((s) => !s.signOutTime);

  if (openSession) {
    hadOpenSession = true;
    openSession.signOutTime = signOutDate;
    openSession.signOutTimeStr = signOutTimeFormatted;
    if (note) openSession.note = note;

    const diffMs = signOutDate.getTime() - new Date(openSession.signInTime).getTime();
    const durationMins = diffMs > 0 ? Math.floor(diffMs / (1000 * 60)) : 0;
    openSession.durationMinutes = durationMins;
    openSession.durationStr = formatMinutesToHoursAndMinutes(durationMins);
    thisSessionDurationFormatted = openSession.durationStr;
    sessionNumber = openSession.sessionNumber;
  } else {
    // All previous sessions were already signed out. Update the last session
    hadOpenSession = false;
    const lastSession = record.sessions[record.sessions.length - 1];
    if (lastSession) {
      lastSession.signOutTime = signOutDate;
      lastSession.signOutTimeStr = signOutTimeFormatted;
      if (note) lastSession.note = note;

      const diffMs = signOutDate.getTime() - new Date(lastSession.signInTime).getTime();
      const durationMins = diffMs > 0 ? Math.floor(diffMs / (1000 * 60)) : 0;
      lastSession.durationMinutes = durationMins;
      lastSession.durationStr = formatMinutesToHoursAndMinutes(durationMins);
      thisSessionDurationFormatted = lastSession.durationStr;
      sessionNumber = lastSession.sessionNumber;
    }
  }

  // Sum up durationMinutes across all sessions for today
  const totalMinutesToday = record.sessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);
  totalHoursTodayFormatted = formatMinutesToHoursAndMinutes(totalMinutesToday);

  record.lastSignOutTime = signOutDate;
  record.lastSignOutTimeStr = signOutTimeFormatted;
  record.signOutTime = signOutDate;
  record.totalMinutesWorked = totalMinutesToday;
  record.totalHours = totalHoursTodayFormatted;
  record.status = 'Signed-Out';
  if (note) record.note = note;

  await record.save();

  console.log(
    `[DB] Recorded Sign-Out for ${name} (${phoneNumber}). Session #${sessionNumber}: ${thisSessionDurationFormatted}, Total Worked Today: ${totalHoursTodayFormatted}`
  );

  return {
    record,
    formattedTime: signOutTimeFormatted,
    sessionDuration: thisSessionDurationFormatted,
    totalHours: totalHoursTodayFormatted,
    sessionNumber,
    completedSessionsCount: record.sessions.length,
    hadOpenSession,
  };
}

/**
 * Handles Leave: saves leave record with reason/note.
 */
async function handleLeave({ name, phoneNumber, note }) {
  const todayStr = getTodayDateString();

  const record = await Attendance.findOneAndUpdate(
    { phoneNumber, date: todayStr },
    {
      $set: {
        name,
        phoneNumber,
        date: todayStr,
        status: 'Leave',
        note: note || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`[DB] Recorded Leave for ${name} (${phoneNumber}). Reason: ${note || 'None'}`);
  return record;
}

/**
 * Handles Late notification.
 */
async function handleLate({ name, phoneNumber, note }) {
  const todayStr = getTodayDateString();

  let record = await Attendance.findOne({
    phoneNumber,
    date: todayStr,
  });

  if (!record) {
    record = await Attendance.create({
      name,
      phoneNumber,
      date: todayStr,
      status: 'Late',
      note: note || null,
    });
  } else if (record.status !== 'Present' && record.status !== 'Signed-Out') {
    record.name = name;
    record.status = 'Late';
    if (note) record.note = note;
    await record.save();
  }

  console.log(`[DB] Recorded Late notice for ${name} (${phoneNumber}). Reason: ${note || 'None'}`);
  return record;
}

// ==========================================
// 5. WhatsApp Client Initialization & Safe Startup
// ==========================================
console.log('⏳ Initializing WhatsApp Web Client...');

// Auto-clean any orphaned Chromium processes and stale locks from previous runs
if (process.platform === 'win32') {
  try {
    const psScript = `
$chromeProcs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*wwebjs_auth*' }
if ($chromeProcs) {
    foreach ($p in $chromeProcs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'ignore' });
  } catch (e) { }
}

const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
for (const f of ['lockfile', 'DevToolsActivePort']) {
  const fullPath = path.join(sessionDir, f);
  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch (e) { }
  }
}

const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : fs.existsSync('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')
      ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      : fs.existsSync('/usr/bin/chromium')
        ? '/usr/bin/chromium'
        : fs.existsSync('/usr/bin/chromium-browser')
          ? '/usr/bin/chromium-browser'
          : fs.existsSync('/usr/bin/google-chrome-stable')
            ? '/usr/bin/google-chrome-stable'
            : undefined);

if (chromePath) {
  console.log(`🌐 Using Google Chrome: ${chromePath}`);
}

const phoneNumberToPair = (PAIR_WITH_PHONE_NUMBER || '').trim().replace(/[^0-9]/g, '');

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth',
  }),
  pairWithPhoneNumber: phoneNumberToPair
    ? {
      phoneNumber: phoneNumberToPair,
      showNotification: true,
    }
    : undefined,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  puppeteer: {
    headless: true,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-zygote',
    ],
  },
});

client.on('code', (code) => {
  console.log('\n======================================================');
  console.log(`🔑 WhatsApp Pairing Code: ${code}`);
  console.log('📱 On your phone: WhatsApp > Linked Devices > Link a device');
  console.log('   Tap "Link with phone number instead" and enter this code.');
  console.log('======================================================\n');
});

client.on('qr', (qr) => {
  console.log('\n======================================================');
  console.log('📱 Scan this QR code with WhatsApp on your phone:');
  console.log('======================================================\n');
  qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Loading WhatsApp Web: ${percent}% - ${message || 'syncing...'}`);
});

let isReadyEmitted = false;

client.on('authenticated', () => {
  console.log('🔐 WhatsApp authenticated successfully. Local session saved.');

  // Auto-sync watchdog for whatsapp-web.js v1.26.0
  let attempts = 0;
  const syncInterval = setInterval(async () => {
    if (isReadyEmitted) {
      clearInterval(syncInterval);
      return;
    }
    attempts++;
    try {
      if (client.pupPage) {
        await client.pupPage.evaluate(() => {
          if (typeof window.onAppStateHasSyncedEvent === 'function') {
            window.onAppStateHasSyncedEvent();
          }
        });
      }
    } catch (e) { }

    if (attempts >= 10 || isReadyEmitted) {
      clearInterval(syncInterval);
    }
  }, 2000);
});

client.on('auth_failure', (msg) => {
  console.error('❌ WhatsApp authentication failed:', msg);
});

client.on('ready', async () => {
  isReadyEmitted = true;
  console.log('\n======================================================');
  console.log('🚀 Huelux WhatsApp Attendance Bot is READY and listening!');
  console.log(`🎯 Target Group: "${GROUP_NAME}"`);
  console.log(`🎯 Target Group ID: "${KNOWN_TARGET_GROUP_ID}"`);
  console.log('======================================================\n');
});

// ==========================================
// 6. Incoming Message Listener & AI Processing
// ==========================================

/**
 * Safely sends a reply to the group chat. Works reliably for both incoming messages
 * from team members and self-sent/admin test messages from the host phone.
 */
async function safeReply(chatId, msg, replyText) {
  try {
    if (msg.id?._serialized) {
      await client.sendMessage(chatId, replyText, { quotedMessageId: msg.id._serialized });
    } else {
      await client.sendMessage(chatId, replyText);
    }
  } catch (err) {
    console.warn(`⚠️ Quoted reply failed (${err.message}). Sending direct message to group...`);
    try {
      await client.sendMessage(chatId, replyText);
    } catch (e) {
      console.error(`❌ Failed to send direct message to group ${chatId}:`, e.message);
    }
  }
}

// Deduplication set to avoid processing same message if both event handlers fire
const processedMessageIds = new Set();

async function handleMessage(msg) {
  try {
    const msgId = msg.id?._serialized || `${msg.id?.remote}_${msg.timestamp}`;
    if (processedMessageIds.has(msgId)) return;
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value;
      processedMessageIds.delete(first);
    }

    // 1. Prevent infinite loops: ignore the bot's own automated attendance responses
    if (
      msg.fromMe &&
      msg.body &&
      (msg.body.trim().startsWith('✅') ||
        msg.body.trim().startsWith('👋') ||
        msg.body.trim().startsWith('📝') ||
        msg.body.trim().startsWith('⏱️') ||
        msg.body.trim().startsWith('📢'))
    ) {
      return;
    }

    if (!msg.body || typeof msg.body !== 'string' || !msg.body.trim()) return;

    // 2. Identify Chat ID (In WhatsApp Web, msg.id.remote is always the real chat/group ID)
    const chatId = msg.id?.remote || (msg.fromMe ? msg.to : msg.from) || '';

    // Only process messages from WhatsApp Groups (@g.us)
    if (!chatId.endsWith('@g.us')) {
      return;
    }

    // Retrieve chat details for name verification
    let chat = null;
    try {
      chat = await Promise.race([
        client.getChatById(chatId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
    } catch (err) { }

    const chatName = chat?.name || '';
    const targetGroup = (GROUP_NAME || '').trim().toLowerCase();
    const chatNameLower = chatName.toLowerCase();

    // Verify target group (checks exact group ID, exact name, partial match, or core keywords)
    const isTargetGroup =
      chatId === KNOWN_TARGET_GROUP_ID ||
      !chatName || // If chat metadata isn't cached yet, permit group
      chatNameLower === targetGroup ||
      chatNameLower.includes(targetGroup) ||
      targetGroup.includes(chatNameLower) ||
      (chatNameLower.includes('attendance') && chatNameLower.includes('zaynlo')) ||
      chatNameLower.includes('attendance') ||
      chatNameLower.includes('zaynlo');

    if (!isTargetGroup) {
      console.log(`⏩ [Ignored Group] Message in "${chatName || chatId}" does not match target group.`);
      return;
    }

    // 3. Sender ID & Official Name Mapping (Handle LIDs & multi-device numbers)
    let contact = null;
    try {
      contact = await msg.getContact();
    } catch (err) { }

    const rawSender = msg.author || (msg.fromMe ? (client.info?.wid?._serialized || msg.from) : msg.from) || '';
    const senderDigits = (rawSender || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    // Canonical mobile number resolution:
    // If contact.number exists and is a valid phone number, use it.
    // If it's a known privacy LID (e.g. 102340614971456), map it to the actual mobile number.
    let resolvedPhone = contact?.number || senderDigits;
    if (lidToPhoneMap[resolvedPhone]) {
      resolvedPhone = lidToPhoneMap[resolvedPhone];
    } else if (lidToPhoneMap[senderDigits]) {
      resolvedPhone = lidToPhoneMap[senderDigits];
    }

    // Official Name resolution from teamMembers dictionary
    let userName = null;
    if (teamMembers[resolvedPhone]) {
      userName = teamMembers[resolvedPhone];
    } else if (teamMembers[`${resolvedPhone}@c.us`]) {
      userName = teamMembers[`${resolvedPhone}@c.us`];
    } else if (teamMembers[senderDigits]) {
      userName = teamMembers[senderDigits];
    } else if (teamMembers[rawSender]) {
      userName = teamMembers[rawSender];
    }

    // Check fuzzy match on teamMembers
    if (!userName) {
      for (const [key, name] of Object.entries(teamMembers)) {
        const keyNum = key.split('@')[0].replace(/[^0-9]/g, '');
        if (resolvedPhone === keyNum || resolvedPhone.endsWith(keyNum) || keyNum.endsWith(resolvedPhone)) {
          userName = name;
          break;
        }
      }
    }

    if (!userName) {
      userName = contact?.pushname || contact?.name || (msg.fromMe ? client.info?.pushname : null) || 'Team Member';
    }

    const phoneNumber = resolvedPhone || senderDigits;

    console.log(`\n📩 Incoming message in [${chatName || chatId}] from ${userName} (${phoneNumber}):\n"${msg.body}"`);

    // 4. Classify intent, time, and note with Gemini AI (with fast fallback)
    const { intent, time, note } = await classifyMessageWithGemini(msg.body);
    console.log(`🤖 Classification -> Intent: ${intent}, Time: ${time || 'N/A'}, Note: ${note || 'None'}`);

    // 5. Dynamic Multi-Session State Management & Replies
    if (intent === 'OTHER') {
      // Ignore completely. Do not reply.
      return;
    }

    if (intent === 'SIGN_IN') {
      const { formattedTime, sessionNumber, isNewSession } = await handleSignIn({
        name: userName,
        phoneNumber,
        timeStr: time,
        note,
      });

      const noteText = note ? `\n📝 Note: ${note}` : '';
      const sessionTag = sessionNumber > 1 ? ` (Session #${sessionNumber})` : '';
      const welcomeText = sessionNumber > 1 ? 'Welcome back!' : 'Have a productive day at Huelux!';

      const reply = isNewSession
        ? `✅ Sign-in recorded for ${userName}!\n⏰ Sign-In Time: ${formattedTime}${sessionTag}\n${welcomeText}${noteText}`
        : `✅ Sign-in updated for ${userName}!\n⏰ Sign-In Time: ${formattedTime} (Session #${sessionNumber})${noteText}`;

      await safeReply(chatId, msg, reply);
      console.log(`📢 [Reply Sent] Sign-in recorded for ${userName} at ${formattedTime} (Session #${sessionNumber})`);
    } else if (intent === 'SIGN_OUT') {
      const {
        formattedTime,
        sessionDuration,
        totalHours,
        sessionNumber,
        completedSessionsCount,
        hadOpenSession,
      } = await handleSignOut({
        name: userName,
        phoneNumber,
        timeStr: time,
        note,
      });

      const noteText = note ? `\n📝 Note: ${note}` : '';

      if (completedSessionsCount > 1) {
        const reply = `👋 Sign-out recorded for ${userName}!\n⏰ Sign-Out Time: ${formattedTime}\n⏱️ Session #${sessionNumber} Time: ${sessionDuration}\n⏳ Total Worked Today: ${totalHours} (${completedSessionsCount} sessions).${noteText}`;
        await safeReply(chatId, msg, reply);
        console.log(`📢 [Reply Sent] Sign-out recorded for ${userName}. Total Today: ${totalHours}`);
      } else if (hadOpenSession) {
        const reply = `👋 Sign-out recorded for ${userName}!\n⏰ Sign-Out Time: ${formattedTime}\n⏳ Total Worked Today: ${totalHours}.${noteText}`;
        await safeReply(chatId, msg, reply);
        console.log(`📢 [Reply Sent] Sign-out recorded for ${userName}. Total: ${totalHours}`);
      } else {
        const reply = `👋 Sign-out recorded for ${userName}!\n⏰ Sign-Out Time: ${formattedTime}\n⏳ Total Worked Today: ${totalHours}\n⚠️ Note: No open sign-in found for this session.${noteText}`;
        await safeReply(chatId, msg, reply);
        console.log(`📢 [Reply Sent] Sign-out recorded for ${userName} at ${formattedTime}`);
      }
    } else if (intent === 'LEAVE') {
      await handleLeave({
        name: userName,
        phoneNumber,
        note,
      });

      const reply = `📝 Leave noted for ${userName}. Reason: ${note || 'Not specified'}.`;
      await safeReply(chatId, msg, reply);
      console.log(`📢 [Reply Sent] Leave noted for ${userName}`);
    } else if (intent === 'LATE') {
      await handleLate({
        name: userName,
        phoneNumber,
        note,
      });

      const reply = `⏱️ Update noted, ${userName}. Please punch in (Sign in) when you start working. Reason: ${note || 'Not specified'}.`;
      await safeReply(chatId, msg, reply);
      console.log(`📢 [Reply Sent] Late noted for ${userName}`);
    }
  } catch (error) {
    console.error('❌ Error processing message:', error);
  }
}

// Hook both events to guarantee no message is missed across different Puppeteer environments
client.on('message_create', handleMessage);
client.on('message', handleMessage);

client.on('disconnected', (reason) => {
  console.warn('⚠️ WhatsApp client disconnected:', reason);
});

// ==========================================
// 7. Startup, Health Check HTTP Server & Graceful Shutdown
// ==========================================
const http = require('http');

async function startApp() {
  await connectToDatabase();

  // Start lightweight HTTP health-check server for Render / Cloud Web Services
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'Zaynlo WhatsApp Attendance Bot',
        whatsappReady: isReadyEmitted,
        timestamp: new Date().toISOString(),
      })
    );
  });

  server.listen(PORT, () => {
    console.log(`🌐 Health-check HTTP server listening on port ${PORT}`);
  });

  client.initialize();
}

async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  try {
    await client.destroy();
    console.log('WhatsApp client destroyed.');
  } catch (err) { }
  try {
    await mongoose.disconnect();
    console.log('MongoDB connection closed.');
  } catch (err) { }
  process.exit(0);
}

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (
    msg.includes('Execution context was destroyed') ||
    msg.includes('Target closed') ||
    msg.includes('Session closed')
  ) {
    console.warn('⚠️ WhatsApp page navigation in progress, continuing...');
    return;
  }
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startApp();
