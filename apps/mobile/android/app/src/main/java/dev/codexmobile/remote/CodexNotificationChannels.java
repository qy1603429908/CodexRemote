package dev.codexmobile.remote;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

final class CodexNotificationChannels {
    static final String BACKGROUND = "codex_background_v1";
    // Channel sound/importance is immutable after first creation. v2 gives existing
    // installations the corrected audible channels instead of inheriting silent v1 state.
    static final String APPROVALS = "codex_approvals_v2";
    static final String COMPLETIONS = "codex_completions_v2";

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

        Uri alertSound = Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE
                + "://" + context.getPackageName() + "/" + R.raw.codex_notification);
        AudioAttributes alertAudio = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();

        NotificationChannel approvals = new NotificationChannel(
                APPROVALS,
                context.getString(R.string.notification_channel_approvals),
                NotificationManager.IMPORTANCE_HIGH);
        approvals.setDescription(context.getString(R.string.notification_channel_approvals_description));
        approvals.setShowBadge(true);
        approvals.enableVibration(true);
        approvals.setVibrationPattern(new long[] {0, 260, 120, 260});
        approvals.setSound(alertSound, alertAudio);
        approvals.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(approvals);

        NotificationChannel completions = new NotificationChannel(
                COMPLETIONS,
                context.getString(R.string.notification_channel_completions),
                NotificationManager.IMPORTANCE_HIGH);
        completions.setDescription(context.getString(R.string.notification_channel_completions_description));
        completions.setShowBadge(true);
        completions.enableVibration(true);
        completions.setVibrationPattern(new long[] {0, 150, 90, 150});
        completions.setSound(alertSound, alertAudio);
        completions.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(completions);
    }
}
