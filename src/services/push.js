const { sendFcmPush } = require('./fcmPush');
const { oneSignal } = require('../config/env');

/**
 * Unified Push Dispatcher
 * Dispatches via FCM (Firebase Cloud Messaging) and Expo Push,
 * with fallback to OneSignal if configured.
 */
async function sendPush(userIds, title, message, data = {}) {
  if (!Array.isArray(userIds) || !userIds.length) return;

  // 1. Primary Dispatch: FCM (Firebase Cloud Messaging) & Expo Push
  try {
    await sendFcmPush(userIds, title, message, data);
  } catch (err) {
    console.error('[Push/FCM] Error in FCM dispatcher:', err.message);
  }

  // 2. Secondary Dispatch: OneSignal (if configured)
  if (oneSignal.appId && oneSignal.apiKey) {
    try {
      await fetch('https://api.onesignal.com/notifications?c=push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Key ${oneSignal.apiKey}` },
        body: JSON.stringify({
          app_id: oneSignal.appId,
          target_channel: 'push',
          include_aliases: { external_id: userIds.map(String) },
          headings: { en: title },
          contents: { en: message },
          data,
        }),
      });
    } catch (e) {
      // Non-blocking fallback
    }
  }
}

module.exports = { sendPush };
