package dev.codexmobile.remote;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** Minimal durable index used to reconcile notifications after the Service process restarts. */
final class CodexNotificationLedger {
    private static final String PREFS = "codex_background_notification_ledger_v1";
    private static final String KEY_APPROVALS = "approvals";
    private static final String KEY_ATTENTION = "attention";
    private static final String KEY_NOTIFICATION_IDS = "notification_ids";
    private static final String KEY_FINGERPRINT = "credential_fingerprint";

    private final SharedPreferences preferences;

    CodexNotificationLedger(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized Map<String, String> approvals() {
        return decodeMap(preferences.getString(KEY_APPROVALS, "{}"));
    }

    synchronized Map<String, String> attentions() {
        return decodeMap(preferences.getString(KEY_ATTENTION, "{}"));
    }

    synchronized Map<String, String> notificationIds() {
        return decodeMap(preferences.getString(KEY_NOTIFICATION_IDS, "{}"));
    }

    synchronized String fingerprint() {
        return preferences.getString(KEY_FINGERPRINT, "");
    }

    synchronized void setFingerprint(String fingerprint) {
        preferences.edit().putString(KEY_FINGERPRINT, fingerprint == null ? "" : fingerprint).commit();
    }

    synchronized void putApproval(String requestId, String threadId) {
        Map<String, String> values = approvals();
        values.put(requestId, threadId);
        preferences.edit().putString(KEY_APPROVALS, encodeMap(values)).commit();
    }

    synchronized void removeApproval(String requestId) {
        Map<String, String> values = approvals();
        if (values.remove(requestId) != null) preferences.edit().putString(KEY_APPROVALS, encodeMap(values)).commit();
    }

    synchronized void putAttention(String threadId, String state) {
        Map<String, String> values = attentions();
        values.put(threadId, state);
        preferences.edit().putString(KEY_ATTENTION, encodeMap(values)).commit();
    }

    synchronized void removeAttention(String threadId) {
        Map<String, String> values = attentions();
        if (values.remove(threadId) != null) preferences.edit().putString(KEY_ATTENTION, encodeMap(values)).commit();
    }

    synchronized void putNotification(int notificationId, String threadId) {
        Map<String, String> values = notificationIds();
        values.put(String.valueOf(notificationId), threadId);
        preferences.edit().putString(KEY_NOTIFICATION_IDS, encodeMap(values)).commit();
    }

    synchronized void removeNotification(int notificationId) {
        Map<String, String> values = notificationIds();
        if (values.remove(String.valueOf(notificationId)) != null) {
            preferences.edit().putString(KEY_NOTIFICATION_IDS, encodeMap(values)).commit();
        }
    }

    synchronized void clearNotificationState() {
        preferences.edit()
                .remove(KEY_APPROVALS)
                .remove(KEY_ATTENTION)
                .remove(KEY_NOTIFICATION_IDS)
                .commit();
    }

    synchronized void clear() {
        preferences.edit().clear().commit();
    }

    static Map<String, String> decodeMap(String raw) {
        Map<String, String> result = new HashMap<>();
        if (raw == null || raw.isEmpty()) return result;
        try {
            JSONObject object = new JSONObject(raw);
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = object.optString(key, "");
                if (!key.isEmpty() && !value.isEmpty()) result.put(key, value);
            }
        } catch (JSONException ignored) {
            // Corrupt process-recovery metadata must never prevent the foreground service starting.
        }
        return result;
    }

    static String encodeMap(Map<String, String> values) {
        return new JSONObject(values).toString();
    }
}
