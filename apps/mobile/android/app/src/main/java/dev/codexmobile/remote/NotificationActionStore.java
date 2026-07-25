package dev.codexmobile.remote;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;

import java.util.UUID;

final class NotificationActionStore {
    static final String EXTRA_SOURCE = "codexNotificationSource";
    static final String EXTRA_THREAD_ID = "threadId";
    static final String EXTRA_ACTION = "action";
    static final String EXTRA_KIND = "notificationKind";
    static final String EXTRA_NONCE = "notificationNonce";

    private static final String PREFS = "codex_mobile_notification_actions";
    private static final String KEY_THREAD_ID = "threadId";
    private static final String KEY_ACTION = "action";
    private static final String KEY_KIND = "kind";
    private static final String KEY_NONCE = "nonce";
    private static final String KEY_PENDING = "pending";

    private NotificationActionStore() {}

    static Intent decorate(Intent intent, String threadId, String action, String kind) {
        intent.putExtra(EXTRA_SOURCE, true);
        intent.putExtra(EXTRA_THREAD_ID, safe(threadId));
        intent.putExtra(EXTRA_ACTION, safe(action));
        intent.putExtra(EXTRA_KIND, safe(kind));
        intent.putExtra(EXTRA_NONCE, UUID.randomUUID().toString());
        return intent;
    }

    static boolean isNotificationIntent(Intent intent) {
        return intent != null && intent.getBooleanExtra(EXTRA_SOURCE, false);
    }

    static JSObject fromIntent(Intent intent) {
        if (!isNotificationIntent(intent)) {
            return null;
        }
        JSObject result = new JSObject();
        result.put("threadId", safe(intent.getStringExtra(EXTRA_THREAD_ID)));
        result.put("action", safe(intent.getStringExtra(EXTRA_ACTION)));
        result.put("kind", safe(intent.getStringExtra(EXTRA_KIND)));
        result.put("nonce", safe(intent.getStringExtra(EXTRA_NONCE)));
        return result;
    }

    static void persist(Context context, JSObject payload) {
        if (payload == null) {
            return;
        }
        preferences(context).edit()
                .putBoolean(KEY_PENDING, true)
                .putString(KEY_THREAD_ID, payload.optString("threadId", ""))
                .putString(KEY_ACTION, payload.optString("action", ""))
                .putString(KEY_KIND, payload.optString("kind", ""))
                .putString(KEY_NONCE, payload.optString("nonce", ""))
                .apply();
    }

    static JSObject consume(Context context) {
        SharedPreferences preferences = preferences(context);
        if (!preferences.getBoolean(KEY_PENDING, false)) {
            return null;
        }
        JSObject result = new JSObject();
        result.put("threadId", preferences.getString(KEY_THREAD_ID, ""));
        result.put("action", preferences.getString(KEY_ACTION, ""));
        result.put("kind", preferences.getString(KEY_KIND, ""));
        result.put("nonce", preferences.getString(KEY_NONCE, ""));
        preferences.edit().clear().apply();
        return result;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
