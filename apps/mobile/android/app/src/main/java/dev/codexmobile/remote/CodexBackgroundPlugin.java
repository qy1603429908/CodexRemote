package dev.codexmobile.remote;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
        name = "CodexBackground",
        permissions = @Permission(
                alias = CodexBackgroundPlugin.NOTIFICATIONS,
                strings = { Manifest.permission.POST_NOTIFICATIONS }))
public class CodexBackgroundPlugin extends Plugin {
    static final String NOTIFICATIONS = "notifications";
    private static final String EVENT_NOTIFICATION_ACTION = "notificationAction";

    @Override
    public void load() {
        super.load();
        CodexNotificationChannels.ensureCreated(getContext());
        captureNotificationIntent(getActivity() == null ? null : getActivity().getIntent(), false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        captureNotificationIntent(intent, true);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", CodexBackgroundService.isMarkedRunning(getContext()));
        result.put("notificationsGranted", notificationsGranted());
        result.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!requireNotifications(call)) {
            return;
        }
        try {
            CodexBackgroundService.start(
                    getContext(),
                    call.getString("title"),
                    call.getString("text"),
                    call.getString("threadId"),
                    defaultValue(call.getString("action"), "openBackground"),
                    call.getString("serverUrl"));
            JSObject result = new JSObject();
            result.put("running", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Unable to start foreground service; Android may prohibit background starts", error);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (!requireNotifications(call)) {
            return;
        }
        if (!CodexBackgroundService.isMarkedRunning(getContext())) {
            JSObject result = new JSObject();
            result.put("running", false);
            call.resolve(result);
            return;
        }
        try {
            CodexBackgroundService.update(
                    getContext(),
                    call.getString("title"),
                    call.getString("text"),
                    call.getString("threadId"),
                    call.getString("action"));
            JSObject result = new JSObject();
            result.put("running", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Unable to update foreground service", error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            CodexBackgroundService.stop(getContext());
            JSObject result = new JSObject();
            result.put("running", false);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Unable to stop foreground service", error);
        }
    }

    @PluginMethod
    public void notifyApproval(PluginCall call) {
        if (!requireNotifications(call)) {
            return;
        }
        String threadId = requiredThreadId(call);
        if (threadId == null) {
            return;
        }
        String action = defaultValue(call.getString("action"), "openApproval");
        String title = defaultValue(call.getString("title"), getString(R.string.approval_notification_title));
        String text = defaultValue(call.getString("text"), getString(R.string.approval_notification_text));
        int id = notificationId("approval", threadId, call.getInt("notificationId"));
        showNotification(
                CodexNotificationChannels.APPROVALS,
                "approval",
                threadId,
                action,
                title,
                text,
                id,
                NotificationCompat.PRIORITY_HIGH,
                NotificationCompat.CATEGORY_EVENT,
                true);
        new CodexNotificationLedger(getContext()).putNotification(id, threadId);
        resolveNotification(call, id, "approval", threadId);
    }

    @PluginMethod
    public void notifyCompletion(PluginCall call) {
        if (!requireNotifications(call)) {
            return;
        }
        String threadId = requiredThreadId(call);
        if (threadId == null) {
            return;
        }
        String action = defaultValue(call.getString("action"), "openThread");
        String title = defaultValue(call.getString("title"), getString(R.string.completion_notification_title));
        String text = defaultValue(call.getString("text"), getString(R.string.completion_notification_text));
        int id = notificationId("completion", threadId, call.getInt("notificationId"));
        showNotification(
                CodexNotificationChannels.COMPLETIONS,
                "completion",
                threadId,
                action,
                title,
                text,
                id,
                NotificationCompat.PRIORITY_HIGH,
                NotificationCompat.CATEGORY_EVENT,
                true);
        resolveNotification(call, id, "completion", threadId);
    }

    @PluginMethod
    public void cancelNotification(PluginCall call) {
        String kind = call.getString("kind");
        String threadId = call.getString("threadId");
        Integer explicitId = call.getInt("notificationId");
        if (explicitId == null && (kind == null || threadId == null)) {
            call.reject("notificationId or both kind and threadId are required");
            return;
        }
        int id = explicitId == null ? notificationId(kind, threadId, null) : explicitId;
        NotificationManagerCompat.from(getContext()).cancel(id);
        new CodexNotificationLedger(getContext()).removeNotification(id);
        call.resolve();
    }

    @PluginMethod
    public void consumePendingAction(PluginCall call) {
        JSObject pending = NotificationActionStore.consume(getContext());
        JSObject result = new JSObject();
        result.put("action", pending == null ? JSObject.NULL : pending);
        call.resolve(result);
    }

    private boolean requireNotifications(PluginCall call) {
        if (notificationsGranted()) {
            return true;
        }
        call.reject("Notification permission is required; call requestNotificationPermission first", "NOTIFICATION_PERMISSION_REQUIRED");
        return false;
    }

    private boolean notificationsGranted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    private String requiredThreadId(PluginCall call) {
        String threadId = call.getString("threadId");
        if (threadId == null || threadId.trim().isEmpty()) {
            call.reject("threadId is required");
            return null;
        }
        return threadId;
    }

    private void showNotification(
            String channel,
            String kind,
            String threadId,
            String action,
            String title,
            String text,
            int notificationId,
            int priority,
            String category,
            boolean alert) {
        CodexNotificationChannels.ensureCreated(getContext());
        Intent activityIntent = new Intent(getContext(), MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        NotificationActionStore.decorate(activityIntent, threadId, action, kind);
        PendingIntent contentIntent = PendingIntent.getActivity(
                getContext(),
                CodexBackgroundService.requestCode(kind, threadId, action),
                activityIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), channel)
                .setSmallIcon(R.drawable.ic_codex_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setPriority(priority)
                .setCategory(category)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setOnlyAlertOnce(true)
                .setGroup("codex-thread-" + threadId);
        if (alert && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Notification permission was revoked");
        }
        NotificationManagerCompat.from(getContext()).notify(notificationId, builder.build());
    }

    private void captureNotificationIntent(Intent intent, boolean notify) {
        JSObject payload = NotificationActionStore.fromIntent(intent);
        if (payload == null) {
            return;
        }
        NotificationActionStore.persist(getContext(), payload);
        if (notify) {
            notifyListeners(EVENT_NOTIFICATION_ACTION, payload, true);
        }
        intent.removeExtra(NotificationActionStore.EXTRA_SOURCE);
    }

    private void resolveNotification(PluginCall call, int id, String kind, String threadId) {
        JSObject result = new JSObject();
        result.put("notificationId", id);
        result.put("kind", kind);
        result.put("threadId", threadId);
        call.resolve(result);
    }

    private int notificationId(String kind, String threadId, Integer explicitId) {
        if (explicitId != null) {
            return explicitId;
        }
        int id = CodexBackgroundService.requestCode(kind, threadId, "notification");
        return id == 0 ? 1 : id;
    }

    private String getString(int resourceId) {
        return getContext().getString(resourceId);
    }

    private static String defaultValue(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}
