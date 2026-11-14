const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');

/**
 * FCM Push Notification Service
 * Supports:
 * - Direct FCM v1 via Firebase Admin SDK (gate-enter)
 * - Expo Push Notification Gateway (which routes to FCM for Android and APNs for iOS)
 * - MySQL token registry (fcm_tokens_app)
 */

let messaging = null;
let firebaseInitialized = false;

try {
  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  const { getMessaging } = require('firebase-admin/messaging');

  let credential = null;

  // 1. Direct environment variables: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    try {
      credential = cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      });
      console.log('[FCM] Firebase Admin configured via individual environment variables.');
    } catch (e) {
      console.warn('[FCM] Error parsing individual Firebase env vars:', e.message);
    }
  }

  // 2. Direct JSON string in FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_SERVICE_ACCOUNT_JSON
  if (!credential) {
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (rawJson && rawJson.trim().startsWith('{')) {
      try {
        const keyJson = JSON.parse(rawJson.trim());
        credential = cert(keyJson);
        console.log('[FCM] Firebase Admin configured via JSON string in environment variable.');
      } catch (e) {
        console.warn('[FCM] Error parsing Firebase JSON env var:', e.message);
      }
    }
  }

  // 3. Base64 encoded JSON in FIREBASE_SERVICE_ACCOUNT_BASE64
  if (!credential && process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
      const keyJson = JSON.parse(decoded);
      credential = cert(keyJson);
      console.log('[FCM] Firebase Admin configured via Base64 environment variable.');
    } catch (e) {
      console.warn('[FCM] Error parsing Firebase Base64 env var:', e.message);
    }
  }

  // 4. File path on disk
  if (!credential) {
    const possiblePaths = [
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
      path.resolve(__dirname, '../../firebase-service-account.json'),
      path.resolve(process.cwd(), 'firebase-service-account.json'),
      path.resolve(process.cwd(), 'gate-enter-firebase-adminsdk-fbsvc-85b7f320a7.json'),
      path.resolve(__dirname, '../../../gate-enter-firebase-adminsdk-fbsvc-85b7f320a7.json'),
      'd:/MaterialScan/gate-enter-firebase-adminsdk-fbsvc-85b7f320a7.json',
      'd:/MaterialScan/MaterialScan/backend/firebase-service-account.json',
    ].filter(Boolean);

    const keyFile = possiblePaths.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });

    if (keyFile) {
      const keyJson = JSON.parse(fs.readFileSync(path.resolve(keyFile), 'utf8'));
      credential = cert(keyJson);
      console.log(`[FCM] Firebase Admin configured via key file: ${path.basename(keyFile)}`);
    }
  }

  if (credential) {
    let app;
    if (!getApps().length) {
      app = initializeApp({ credential });
    } else {
      app = getApps()[0];
    }
    messaging = getMessaging(app);
    firebaseInitialized = true;
    console.log('[FCM] Firebase Admin SDK v1 initialized successfully (gate-enter)');
  } else {
    console.warn('[FCM] Note: Firebase Admin credentials not found. Direct FCM v1 will wait for credentials.');
  }
} catch (err) {
  console.warn('[FCM] Firebase Admin initialization note:', err.message);
}

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || '';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const FCM_LEGACY_URL = 'https://fcm.googleapis.com/fcm/send';

/**
 * Register or update an FCM / Push token for a user
 */
async function registerFcmToken(userId, token, platform = 'android', deviceName = 'Mobile Device') {
  if (!userId || !token) return false;
  const cleanTok = token.trim();
  const isExpo = cleanTok.startsWith('ExponentPushToken[') || cleanTok.startsWith('ExpoPushToken[');

  try {
    // If registering a new native token, remove any older dead native tokens for this user
    if (!isExpo) {
      await pool.query(
        `DELETE FROM fcm_tokens_app 
         WHERE user_id = ? AND token != ? AND token NOT LIKE 'Expo%'`,
        [userId, cleanTok]
      ).catch(() => {});
    }

    await pool.query(
      `INSERT INTO fcm_tokens_app (user_id, token, platform, device_name)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         platform = VALUES(platform),
         device_name = VALUES(device_name),
         updated_at = NOW()`,
      [userId, cleanTok, platform, deviceName]
    );

    // Also update primary fcm_token on user_app if column exists
    await pool.query(
      `UPDATE user_app SET app_name = COALESCE(app_name, 'MaterialScan') WHERE id = ?`,
      [userId]
    ).catch(() => {});

    console.log(`[FCM] Registered fresh push token for user #${userId} (${platform}): ${cleanTok.slice(0, 15)}...`);
    return true;
  } catch (err) {
    console.error('[FCM] Error registering token:', err.message);
    return false;
  }
}

/**
 * Retrieve registered push tokens for a list of user IDs (newest/freshest first)
 */
async function getTokensForUsers(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return [];
  try {
    const [rows] = await pool.query(
      `SELECT token, platform, user_id AS userId
       FROM fcm_tokens_app
       WHERE user_id IN (?) AND token IS NOT NULL AND token != ''
       ORDER BY updated_at DESC, id DESC`,
      [userIds]
    );
    return rows;
  } catch (err) {
    console.warn('[FCM] Could not query fcm_tokens_app:', err.message);
    return [];
  }
}

/**
 * Send push notification via FCM / Expo to specified user IDs
 */
async function sendFcmPush(userIds, title, message, data = {}) {
  if (!Array.isArray(userIds) || !userIds.length) return { sent: 0, failed: 0 };

  const tokenRows = await getTokensForUsers(userIds);
  if (!tokenRows.length) {
    console.log(`[FCM] No registered push tokens found for users: [${userIds.join(', ')}]. In-app notification delivered.`);
    return { sent: 0, failed: 0 };
  }

  // Group tokens by user to prevent duplicate notifications (never send both Expo and Direct to same user)
  // Priority: Direct Native FCM (fastest, high-priority heads up) > Expo Push Gateway
  const tokensByUser = new Map();
  for (const row of tokenRows) {
    const uid = row.userId;
    const tok = (row.token || '').trim();
    if (!tok) continue;
    if (!tokensByUser.has(uid)) {
      tokensByUser.set(uid, []);
    }
    tokensByUser.get(uid).push(tok);
  }

  const directFcmTokens = [];
  const expoTokens = [];

  for (const [uid, tokens] of tokensByUser.entries()) {
    const nativeToken = tokens.find(
      (t) => !t.startsWith('ExponentPushToken[') && !t.startsWith('ExpoPushToken[')
    );
    const expoToken = tokens.find(
      (t) => t.startsWith('ExponentPushToken[') || t.startsWith('ExpoPushToken[')
    );

    // If Firebase Admin is initialized and user has a native token, send ONLY via Direct FCM
    if (nativeToken && firebaseInitialized && messaging) {
      directFcmTokens.push(nativeToken);
    } else if (expoToken) {
      // Fallback to Expo if no native token or firebase direct is not ready
      expoTokens.push(expoToken);
    } else if (nativeToken) {
      directFcmTokens.push(nativeToken);
    }
  }

  let sentCount = 0;
  let failedCount = 0;

  // 1. Send via Direct FCM v1 Firebase Admin SDK (Primary, instant, heads-up alarm)
  if (directFcmTokens.length > 0) {
    if (firebaseInitialized && messaging) {
      try {
        const stringData = {};
        for (const [k, v] of Object.entries(data || {})) {
          stringData[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
        stringData.title = String(title);
        stringData.body = String(message);
        stringData.message = String(message);
        stringData.channelId = 'materialscan_alerts';

        const response = await messaging.sendEachForMulticast({
          tokens: directFcmTokens,
          notification: {
            title,
            body: message,
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'materialscan_alerts',
              sound: 'default',
              priority: 'max',
              visibility: 'public',
              defaultSound: true,
              defaultVibrateTimings: true,
            },
          },
          data: stringData,
        });

        sentCount += response.successCount;
        failedCount += response.failureCount;
        console.log(`[FCM/Admin] Dispatched ${response.successCount} direct push notifications via FCM v1 (${response.failureCount} failed).`);

        // Automatically clean up any invalid or expired tokens returned by Google FCM
        response.responses.forEach((resp, idx) => {
          if (!resp.success && resp.error) {
            const errCode = resp.error.code || '';
            const badToken = directFcmTokens[idx];
            console.warn(`[FCM/Admin] Token delivery note (${errCode}): ${badToken?.slice(0, 20)}...`);
            if (
              errCode === 'messaging/registration-token-not-registered' ||
              errCode === 'messaging/invalid-registration-token' ||
              errCode === 'messaging/invalid-argument'
            ) {
              console.log(`[FCM/Admin] 🗑️ Removing stale/unregistered token from database: ${badToken?.slice(0, 20)}...`);
              pool.query('DELETE FROM fcm_tokens_app WHERE token = ?', [badToken]).catch(() => {});
            }
          }
        });
      } catch (e) {
        failedCount += directFcmTokens.length;
        console.error('[FCM/Admin] Error sending direct push:', e.message);
      }
    } else if (FCM_SERVER_KEY) {
      try {
        const payload = {
          registration_ids: directFcmTokens,
          priority: 'high',
          notification: {
            title,
            body: message,
            sound: 'default',
            android_channel_id: 'materialscan_alerts',
          },
          data: {
            title,
            body: message,
            ...data,
          },
        };

        const res = await fetch(FCM_LEGACY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `key=${FCM_SERVER_KEY}`,
          },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          sentCount += directFcmTokens.length;
          console.log(`[FCM] Dispatched ${directFcmTokens.length} direct legacy FCM notifications.`);
        } else {
          failedCount += directFcmTokens.length;
          console.warn(`[FCM] Push failed with status ${res.status}:`, await res.text());
        }
      } catch (e) {
        failedCount += directFcmTokens.length;
        console.error('[FCM] Error sending direct push:', e.message);
      }
    } else {
      console.log(`[FCM] Direct tokens (${directFcmTokens.length}) queued.`);
    }
  }

  // 2. Send via Expo Push Service (for devices without direct FCM)
  if (expoTokens.length > 0) {
    try {
      const messages = expoTokens.map((to) => ({
        to,
        sound: 'default',
        title,
        body: message,
        channelId: 'materialscan_alerts',
        priority: 'high',
        _displayInForeground: true,
        data: {
          title,
          message,
          ...data,
        },
      }));

      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (res.ok) {
        sentCount += expoTokens.length;
        console.log(`[FCM/Expo] Dispatched ${expoTokens.length} push notifications successfully.`);
      } else {
        failedCount += expoTokens.length;
        const errText = await res.text();
        console.warn(`[FCM/Expo] Push failed with status ${res.status}:`, errText);
      }
    } catch (e) {
      failedCount += expoTokens.length;
      console.error('[FCM/Expo] Error dispatching push:', e.message);
    }
  }

  return { sent: sentCount, failed: failedCount };
}

function isFirebaseReady() {
  return !!(firebaseInitialized && messaging);
}

module.exports = {
  registerFcmToken,
  getTokensForUsers,
  sendFcmPush,
  isFirebaseReady,
};

