package dev.codexmobile.remote;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

final class CodexNotificationChannels {
    static final String BACKGROUND = "codex_background_v1";
    static final String APPROVALS = "codex_approvals_v1";
    static final String COMPLETIONS = "codex_completions_v1";

    private CodexNotificationChannels() {}

    static void ensureCreated(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        NotificationChannel background = new NotificationChannel(
                BACKGROUND,
                context.getString(R.string.notification_channel_background),
                NotificationManager.IMPORTANCE_LOW);
        background.setDescription(context.getString(R.string.notification_channel_background_description));
        background.setShowBadge(false);
        background.enableVibration(false);
        background.setSound(null, null);
        manager.createNotificationChannel(background);

        NotificationChannel approvals = new NotificationChannel(
                APPROVALS,
                context.getString(R.string.notification_channel_approvals),
                NotificationManager.IMPORTANCE_HIGH);
        approvals.setDescription(context.getString(R.string.notification_channel_approvals_description));
        approvals.setShowBadge(true);
        approvals.enableVibration(true);
        approvals.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(approvals);

        NotificationChannel completions = new NotificationChannel(
                COMPLETIONS,
                context.getString(R.string.notification_channel_completions),
                NotificationManager.IMPORTANCE_DEFAULT);
        completions.setDescription(context.getString(R.string.notification_channel_completions_description));
        completions.setShowBadge(true);
        completions.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(completions);
    }
}
