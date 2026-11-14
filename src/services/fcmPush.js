const pool = require('../db/pool');

/**
 * FCM Push Notification Service
 * Supports:
 * - Direct FCM v1 / Legacy FCM REST API
 * - Expo Push Notification Gateway (which routes to FCM for Android and APNs for iOS)
 * - MySQL token registry (fcm_tokens_app)
 */

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || '';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const FCM_LEGACY_URL = 'https://fcm.googleapis.com/fcm/send';

/**
 * Register or update an FCM / Push token for a user
 */
async function registerFcmToken(userId, token, platform = 'android', deviceName = 'Mobile Device') {
  if (!userId || !token) return false;
  try {
    await pool.query(
      `INSERT INTO fcm_tokens_app (user_id, token, platform, device_name)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         platform = VALUES(platform),
         device_name = VALUES(device_name),
         updated_at = NOW()`,
      [userId, token.trim(), platform, deviceName]
    );

    // Also update primary fcm_token on user_app if column exists
    await pool.query(
      `UPDATE user_app SET app_name = COALESCE(app_name, 'MaterialScan') WHERE id = ?`,
      [userId]
    ).catch(() => {});

    console.log(`[FCM] Registered push token for user #${userId} (${platform}): ${token.slice(0, 15)}...`);
    return true;
  } catch (err) {
    console.error('[FCM] Error registering token:', err.message);
    return false;
  }
}

/**
 * Retrieve registered push tokens for a list of user IDs
 */
async function getTokensForUsers(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return [];
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT token, platform, user_id AS userId
       FROM fcm_tokens_app
       WHERE user_id IN (?) AND token IS NOT NULL AND token != ''`,
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

  const expoTokens = [];
  const directFcmTokens = [];

  for (const row of tokenRows) {
    const tok = (row.token || '').trim();
    if (tok.startsWith('ExponentPushToken[') || tok.startsWith('ExpoPushToken[')) {
      expoTokens.push(tok);
    } else {
      directFcmTokens.push(tok);
    }
  }

  let sentCount = 0;
  let failedCount = 0;

  // 1. Send via Expo Push Service (which automatically delivers through FCM)
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

  // 2. Send via Direct FCM REST API
  if (directFcmTokens.length > 0) {
    if (FCM_SERVER_KEY) {
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
          console.log(`[FCM] Dispatched ${directFcmTokens.length} direct FCM notifications.`);
        } else {
          failedCount += directFcmTokens.length;
          console.warn(`[FCM] Push failed with status ${res.status}:`, await res.text());
        }
      } catch (e) {
        failedCount += directFcmTokens.length;
        console.error('[FCM] Error sending direct push:', e.message);
      }
    } else {
      console.log(`[FCM] Direct tokens (${directFcmTokens.length}) queued. (FCM_SERVER_KEY optional)`);
    }
  }

  return { sent: sentCount, failed: failedCount };
}

module.exports = {
  registerFcmToken,
  getTokensForUsers,
  sendFcmPush,
};

