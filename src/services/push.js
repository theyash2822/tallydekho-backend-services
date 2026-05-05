// Push Notification Service — Expo Push API
// Sends push notifications to mobile devices via Expo's push service
import { Expo } from 'expo-server-sdk';

const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

/**
 * Send push notification to one or more Expo push tokens
 * @param {string|string[]} tokens  - Expo push token(s)
 * @param {object} payload
 * @param {string} payload.title
 * @param {string} payload.body
 * @param {object} [payload.data]   - extra data passed to app
 * @param {string} [payload.sound]  - 'default' or null
 * @param {number} [payload.badge]
 */
export async function sendPushNotification(tokens, { title, body, data = {}, sound = 'default', badge }) {
  const tokenList = Array.isArray(tokens) ? tokens : [tokens];

  // Filter valid Expo tokens
  const validTokens = tokenList.filter(t => Expo.isExpoPushToken(t));
  if (validTokens.length === 0) {
    console.warn('[Push] No valid Expo tokens provided');
    return { success: false, error: 'No valid tokens' };
  }

  // Build messages — chunk to avoid hitting Expo's limit of 100 per request
  const messages = validTokens.map(to => ({
    to,
    title,
    body,
    data,
    sound,
    ...(badge !== undefined ? { badge } : {}),
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const results = [];

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      results.push(...receipts);
      console.log(`[Push] Sent ${chunk.length} notifications`);
    } catch (err) {
      console.error('[Push] Chunk send failed:', err.message);
      results.push({ status: 'error', message: err.message });
    }
  }

  const anyOk = results.some(r => r.status === 'ok');
  return { success: anyOk, results };
}

/**
 * Send payment reminder push notification
 */
export async function sendPaymentReminderPush(tokens, { partyName, amountDue, invoiceNo, dueDate, companyGuid }) {
  return sendPushNotification(tokens, {
    title: '💰 Payment Reminder',
    body: `${partyName} owes ₹${amountDue} — due ${dueDate}`,
    data: {
      type: 'payment_reminder',
      invoiceNo,
      companyGuid,
    },
    sound: 'default',
  });
}

/**
 * Send low stock alert push notification
 */
export async function sendLowStockPush(tokens, { itemName, currentStock, reorderPoint, companyGuid }) {
  return sendPushNotification(tokens, {
    title: '⚠️ Low Stock Alert',
    body: `${itemName} is below reorder point (${currentStock} remaining)`,
    data: {
      type: 'low_stock',
      itemName,
      companyGuid,
    },
    sound: 'default',
  });
}

/**
 * Send compliance reminder push notification
 */
export async function sendCompliancePush(tokens, { title, message, type, companyGuid }) {
  return sendPushNotification(tokens, {
    title: `📋 ${title}`,
    body: message,
    data: { type: 'compliance', complianceType: type, companyGuid },
    sound: 'default',
  });
}

export default { sendPushNotification, sendPaymentReminderPush, sendLowStockPush, sendCompliancePush };
