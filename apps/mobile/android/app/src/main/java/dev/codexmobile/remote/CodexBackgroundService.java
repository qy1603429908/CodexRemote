package dev.codexmobile.remote;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

public class CodexBackgroundService extends Service {
    static final String ACTION_START = "dev.codexmobile.remote.action.START_BACKGROUND";
    static final String ACTION_UPDATE = "dev.codexmobile.remote.action.UPDATE_BACKGROUND";
    static final String ACTION_STOP = "dev.codexmobile.remote.action.STOP_BACKGROUND";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_THREAD_ID = "threadId";
    static final String EXTRA_OPEN_ACTION = "openAction";
    static final String EXTRA_SERVER_URL = "serverUrl";

    private static final String PREFS = "codex_mobile_background_service";
    private static final String KEY_RUNNING = "running";
    private static final String KEY_TITLE = "title";
    private static final String KEY_TEXT = "text";
    private static final String KEY_THREAD_ID = "threadId";
    private static final String KEY_OPEN_ACTION = "openAction";
    private static final String KEY_SERVER_URL = "serverUrl";
    private static final int NOTIFICATION_ID = 41001;
    private CodexBackgroundSocket backgroundSocket;

    @Override
    public void onCreate() {
        super.onCreate();
        CodexNotificationChannels.ensureCreated(this);
        backgroundSocket = new CodexBackgroundSocket(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            markRunning(false);
            if (backgroundSocket != null) backgroundSocket.stop();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        ServiceState previous = readState();
        String title = valueOrFallback(intent, EXTRA_TITLE, previous.title,
                getString(R.string.background_notification_title));
        String text = valueOrFallback(intent, EXTRA_TEXT, previous.text,
                getString(R.string.background_notification_text));
        String threadId = valueOrFallback(intent, EXTRA_THREAD_ID, previous.threadId, "");
        String openAction = valueOrFallback(intent, EXTRA_OPEN_ACTION, previous.openAction, "openBackground");
        String serverUrl = valueOrFallback(intent, EXTRA_SERVER_URL, previous.serverUrl, "");

        persistState(title, text, threadId, openAction, serverUrl, true);
        Notification notification = buildNotification(title, text, threadId, openAction);
        int foregroundType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, foregroundType);
        backgroundSocket.start(serverUrl);
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        markRunning(false);
        if (backgroundSocket != null) backgroundSocket.stop();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    private Notification buildNotification(String title, String text, String threadId, String openAction) {
        Intent activityIntent = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        NotificationActionStore.decorate(activityIntent, threadId, openAction, "background");
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                requestCode("background", threadId, openAction),
                activityIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CodexNotificationChannels.BACKGROUND)
                .setSmallIcon(R.drawable.ic_codex_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .build();
    }

    static void start(Context context, String title, String text, String threadId, String openAction, String serverUrl) {
        Intent intent = command(context, ACTION_START, title, text, threadId, openAction, serverUrl);
        ContextCompat.startForegroundService(context, intent);
    }

    static void update(Context context, String title, String text, String threadId, String openAction) {
        Intent intent = command(context, ACTION_UPDATE, title, text, threadId, openAction, null);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        Intent intent = new Intent(context, CodexBackgroundService.class).setAction(ACTION_STOP);
        context.startService(intent);
    }

    static boolean isMarkedRunning(Context context) {
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null) {
            for (ActivityManager.RunningServiceInfo service : manager.getRunningServices(Integer.MAX_VALUE)) {
                if (CodexBackgroundService.class.getName().equals(service.service.getClassName())) {
                    return true;
                }
            }
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_RUNNING, false)
                .apply();
        return false;
    }

    private static Intent command(
            Context context,
            String action,
            String title,
            String text,
            String threadId,
            String openAction,
            String serverUrl) {
        Intent intent = new Intent(context, CodexBackgroundService.class).setAction(action);
        putIfPresent(intent, EXTRA_TITLE, title);
        putIfPresent(intent, EXTRA_TEXT, text);
        putIfPresent(intent, EXTRA_THREAD_ID, threadId);
        putIfPresent(intent, EXTRA_OPEN_ACTION, openAction);
        putIfPresent(intent, EXTRA_SERVER_URL, serverUrl);
        return intent;
    }

    private static void putIfPresent(Intent intent, String key, String value) {
        if (value != null) {
            intent.putExtra(key, value);
        }
    }

    private static String valueOrFallback(Intent intent, String key, String previous, String fallback) {
        String value = intent == null ? null : intent.getStringExtra(key);
        if (value != null) {
            return value;
        }
        if (previous != null && !previous.isEmpty()) {
            return previous;
        }
        return fallback;
    }

    private void persistState(String title, String text, String threadId, String openAction, String serverUrl, boolean running) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_RUNNING, running)
                .putString(KEY_TITLE, title)
                .putString(KEY_TEXT, text)
                .putString(KEY_THREAD_ID, threadId)
                .putString(KEY_OPEN_ACTION, openAction)
                .putString(KEY_SERVER_URL, serverUrl)
                .apply();
    }

    private void markRunning(boolean running) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_RUNNING, running).apply();
    }

    private ServiceState readState() {
        SharedPreferences preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new ServiceState(
                preferences.getString(KEY_TITLE, ""),
                preferences.getString(KEY_TEXT, ""),
                preferences.getString(KEY_THREAD_ID, ""),
                preferences.getString(KEY_OPEN_ACTION, "openBackground"),
                preferences.getString(KEY_SERVER_URL, ""));
    }

    static int requestCode(String kind, String threadId, String action) {
        String key = kind + "\u0000" + (threadId == null ? "" : threadId)
                + "\u0000" + (action == null ? "" : action);
        return key.hashCode() & 0x7fffffff;
    }

    private static final class ServiceState {
        final String title;
        final String text;
        final String threadId;
        final String openAction;
        final String serverUrl;

        ServiceState(String title, String text, String threadId, String openAction, String serverUrl) {
            this.title = title;
            this.text = text;
            this.threadId = threadId;
            this.openAction = openAction;
            this.serverUrl = serverUrl;
        }
    }
}
