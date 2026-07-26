package dev.codexmobile.remote;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.content.res.AssetFileDescriptor;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

final class CodexNotificationChannels {
    private static final String TAG = "CodexAlertAudio";
    static final String BACKGROUND = "codex_background_v1";
    // Channel sound/importance is immutable after first creation, so differentiated
    // alert tones use fresh channel ids rather than silently mutating an existing channel.
    static final String APPROVALS = "codex_approvals_v4";
    static final String INPUTS = "codex_inputs_v1";
    static final String COMPLETIONS = "codex_completions_v4";

    private static final Object ALERT_LOCK = new Object();
    private static final Handler ALERT_HANDLER = new Handler(Looper.getMainLooper());
    private static final long ALERT_DEDUPE_MS = 900L;
    private static final Map<String, Long> LAST_ALERT_AT = new HashMap<>();
    private static MediaPlayer activeAlert;

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
        approvals.setVibrationPattern(new long[] {0, 180, 80, 180, 80, 260});
        approvals.setSound(rawSoundUri(context, R.raw.codex_approval), alertAudio);
        approvals.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(approvals);

        NotificationChannel inputs = new NotificationChannel(
                INPUTS,
                context.getString(R.string.notification_channel_inputs),
                NotificationManager.IMPORTANCE_HIGH);
        inputs.setDescription(context.getString(R.string.notification_channel_inputs_description));
        inputs.setShowBadge(true);
        inputs.enableVibration(true);
        inputs.setVibrationPattern(new long[] {0, 130, 90, 180});
        inputs.setSound(rawSoundUri(context, R.raw.codex_input), alertAudio);
        inputs.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(inputs);

        NotificationChannel completions = new NotificationChannel(
                COMPLETIONS,
                context.getString(R.string.notification_channel_completions),
                NotificationManager.IMPORTANCE_HIGH);
        completions.setDescription(context.getString(R.string.notification_channel_completions_description));
        completions.setShowBadge(true);
        completions.enableVibration(true);
        completions.setVibrationPattern(new long[] {0, 120, 70, 120});
        completions.setSound(rawSoundUri(context, R.raw.codex_completion), alertAudio);
        completions.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(completions);
    }

    static void playVendorAlertFallback(Context context, String alertKind) {
        long now = SystemClock.elapsedRealtime();
        synchronized (ALERT_LOCK) {
            Long previous = LAST_ALERT_AT.get(alertKind);
            if (previous != null && now - previous < ALERT_DEDUPE_MS) {
                Log.i(TAG, "fallback deduped kind=" + alertKind + " elapsedMs=" + (now - previous));
                return;
            }
            LAST_ALERT_AT.put(alertKind, now);
        }
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        String brand = Build.BRAND == null ? "" : Build.BRAND.toLowerCase(Locale.ROOT);
        Log.i(TAG, "fallback requested kind=" + alertKind + " sdk=" + Build.VERSION.SDK_INT
                + " manufacturer=" + manufacturer + " brand=" + brand);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Log.i(TAG, "fallback skipped: Android version below 14");
            return;
        }
        if (!manufacturer.contains("xiaomi") && !brand.contains("redmi") && !brand.contains("poco")) {
            Log.i(TAG, "fallback skipped: non-Xiaomi family device");
            return;
        }

        AudioManager audio = context.getSystemService(AudioManager.class);
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        int ringerMode = audio == null ? -1 : audio.getRingerMode();
        int notificationVolume = audio == null ? -1 : audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION);
        int maxNotificationVolume = audio == null ? -1 : audio.getStreamMaxVolume(AudioManager.STREAM_NOTIFICATION);
        int filter = notifications == null ? -1 : notifications.getCurrentInterruptionFilter();
        Log.i(TAG, "audio gate ringer=" + ringerMode + " notificationVolume="
                + notificationVolume + "/" + maxNotificationVolume + " interruptionFilter=" + filter);
        if (audio == null || ringerMode != AudioManager.RINGER_MODE_NORMAL || notificationVolume <= 0) {
            Log.w(TAG, "fallback skipped: ringer/notification-volume gate");
            return;
        }
        if (filter == NotificationManager.INTERRUPTION_FILTER_NONE
                || filter == NotificationManager.INTERRUPTION_FILTER_ALARMS) {
            Log.w(TAG, "fallback skipped: interruption filter gate");
            return;
        }

        boolean posted = ALERT_HANDLER.post(() -> {
            Log.i(TAG, "fallback runnable entered on main=" + (Looper.myLooper() == Looper.getMainLooper()));
            synchronized (ALERT_LOCK) {
                MediaPlayer player = null;
                try {
                    releaseActiveAlert();
                    player = new MediaPlayer();
                    player.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                    int soundResource = rawSoundResource(alertKind);
                    try (AssetFileDescriptor sound = context.getResources().openRawResourceFd(soundResource)) {
                        if (sound == null) {
                            Log.e(TAG, "raw notification sound descriptor is null");
                            player.release();
                            return;
                        }
                        Log.i(TAG, "raw sound offset=" + sound.getStartOffset() + " length=" + sound.getLength());
                        player.setDataSource(sound.getFileDescriptor(), sound.getStartOffset(), sound.getLength());
                    }
                    player.setVolume(1.0f, 1.0f);
                    player.setOnCompletionListener(completed -> {
                        Log.i(TAG, "fallback playback completed");
                        synchronized (ALERT_LOCK) {
                            if (activeAlert == completed) activeAlert = null;
                            completed.release();
                        }
                    });
                    player.setOnErrorListener((failed, what, extra) -> {
                        Log.e(TAG, "fallback playback error what=" + what + " extra=" + extra);
                        synchronized (ALERT_LOCK) {
                            if (activeAlert == failed) activeAlert = null;
                            failed.release();
                        }
                        return true;
                    });
                    Log.i(TAG, "preparing fallback MediaPlayer");
                    player.prepare();
                    activeAlert = player;
                    Log.i(TAG, "starting fallback MediaPlayer durationMs=" + player.getDuration());
                    player.start();
                    Log.i(TAG, "fallback MediaPlayer start returned isPlaying=" + player.isPlaying());
                    MediaPlayer startedPlayer = player;
                    ALERT_HANDLER.postDelayed(() -> {
                        synchronized (ALERT_LOCK) {
                            if (activeAlert == startedPlayer) {
                                Log.w(TAG, "fallback timeout release isPlaying=" + startedPlayer.isPlaying());
                                releaseActiveAlert();
                            }
                        }
                    }, 3_000L);
                } catch (Exception error) {
                    Log.e(TAG, "fallback failed", error);
                    if (player != null && player != activeAlert) {
                        try {
                            player.release();
                        } catch (RuntimeException releaseError) {
                            Log.w(TAG, "failed to release local player", releaseError);
                        }
                    }
                    releaseActiveAlert();
                }
            }
        });
        Log.i(TAG, "fallback runnable posted=" + posted);
    }

    private static int rawSoundResource(String alertKind) {
        if ("approval".equals(alertKind)) return R.raw.codex_approval;
        if ("input".equals(alertKind)) return R.raw.codex_input;
        return R.raw.codex_completion;
    }

    private static Uri rawSoundUri(Context context, int resourceId) {
        return Uri.parse("android.resource://" + context.getPackageName() + "/" + resourceId);
    }

    private static void releaseActiveAlert() {
        if (activeAlert == null) return;
        try {
            if (activeAlert.isPlaying()) activeAlert.stop();
        } catch (RuntimeException ignored) {
            // The player may already have completed asynchronously.
        }
        activeAlert.release();
        activeAlert = null;
    }

}
