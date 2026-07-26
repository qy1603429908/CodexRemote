package dev.codexmobile.remote;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

final class CodexBackgroundSocket {
    private static final String WIRE_PROTOCOL = "codex-mobile-v1";
    private static final String TOKEN_KEY = "codex.remote.pairing-token";
    private static final long MAX_RECONNECT_MS = 20_000L;
    private static final long COMPLETION_FALLBACK_DELAY_MS = 900L;
    private static final long COMPLETION_DEDUPE_MS = 2_500L;

    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build();
    private final Map<String, String> threadTitles = new ConcurrentHashMap<>();
    private final Map<String, String> desiredAttention = new ConcurrentHashMap<>();
    private final Map<String, String> notifiedAttention = new ConcurrentHashMap<>();
    private final Map<String, Runnable> attentionTimers = new ConcurrentHashMap<>();
    private final Map<String, String> threadStates = new ConcurrentHashMap<>();
    private final Map<String, Runnable> completionTimers = new ConcurrentHashMap<>();
    private final Map<String, Long> lastCompletionAt = new ConcurrentHashMap<>();
    private final CodexApprovalTracker approvalTracker = new CodexApprovalTracker();
    private final Set<String> notifiedApprovalIds = ConcurrentHashMap.newKeySet();
    private final Set<String> knownThreadIds = ConcurrentHashMap.newKeySet();
    private final CodexNotificationLedger notificationLedger;
    private final Map<String, String> recoveredApprovalEntries = new ConcurrentHashMap<>();
    private final Map<String, String> recoveredAttentionEntries = new ConcurrentHashMap<>();
    private final Map<String, String> recoveredNotificationEntries = new ConcurrentHashMap<>();

    private volatile WebSocket socket;
    private volatile boolean stopped = true;
    private volatile int reconnectAttempts;
    private volatile String serverUrl = "";
    private volatile String credentialFingerprint = "";
    private long socketEpoch;
    private boolean recoveredNotificationsPending;

    CodexBackgroundSocket(Context context) {
        this.context = context.getApplicationContext();
        notificationLedger = new CodexNotificationLedger(this.context);
        credentialFingerprint = notificationLedger.fingerprint();
        recoveredApprovalEntries.putAll(notificationLedger.approvals());
        recoveredAttentionEntries.putAll(notificationLedger.attentions());
        recoveredNotificationEntries.putAll(notificationLedger.notificationIds());
        knownThreadIds.addAll(recoveredApprovalEntries.values());
        knownThreadIds.addAll(recoveredAttentionEntries.keySet());
        knownThreadIds.addAll(recoveredNotificationEntries.values());
        recoveredNotificationsPending = !recoveredApprovalEntries.isEmpty()
                || !recoveredAttentionEntries.isEmpty()
                || !recoveredNotificationEntries.isEmpty();
    }

    synchronized void start(String nextServerUrl) {
        String normalized = nextServerUrl == null ? "" : nextServerUrl.trim();
        String nextFingerprint = credentialFingerprint(normalized);
        boolean restoredSession = serverUrl.isEmpty()
                && !credentialFingerprint.isEmpty()
                && nextFingerprint.equals(credentialFingerprint);
        boolean changed = !restoredSession
                && (!normalized.equals(serverUrl) || !nextFingerprint.equals(credentialFingerprint));
        if (changed) {
            handler.removeCallbacks(reconnectRunnable);
            reconnectAttempts = 0;
            socketEpoch += 1;
            clearSessionState();
            WebSocket active = socket;
            socket = null;
            if (active != null) active.cancel();
        }
        serverUrl = normalized;
        credentialFingerprint = nextFingerprint;
        notificationLedger.setFingerprint(nextFingerprint);
        stopped = false;
        if (socket == null) {
            handler.removeCallbacks(reconnectRunnable);
            connect();
        }
    }

    synchronized void stop() {
        stopped = true;
        socketEpoch += 1;
        handler.removeCallbacksAndMessages(null);
        clearSessionState();
        WebSocket active = socket;
        socket = null;
        if (active != null) active.close(1000, "background service stopped");
        client.dispatcher().cancelAll();
        reconnectAttempts = 0;
        serverUrl = "";
        credentialFingerprint = "";
    }

    private void clearSessionState() {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (Map.Entry<String, String> entry : notifiedAttention.entrySet()) {
            manager.cancel(notificationId("attention:" + entry.getValue() + ":" + entry.getKey()));
        }
        for (String requestId : approvalTracker.requestIds()) {
            manager.cancel(notificationId("approval:" + requestId));
        }
        for (String persistedId : notificationLedger.notificationIds().keySet()) {
            try { manager.cancel(Integer.parseInt(persistedId)); } catch (NumberFormatException ignored) { }
        }
        for (Runnable timer : attentionTimers.values()) handler.removeCallbacks(timer);
        for (Runnable timer : completionTimers.values()) handler.removeCallbacks(timer);
        attentionTimers.clear();
        completionTimers.clear();
        threadStates.clear();
        lastCompletionAt.clear();
        desiredAttention.clear();
        notifiedAttention.clear();
        notifiedApprovalIds.clear();
        approvalTracker.clear();
        knownThreadIds.clear();
        threadTitles.clear();
        recoveredApprovalEntries.clear();
        recoveredAttentionEntries.clear();
        recoveredNotificationEntries.clear();
        recoveredNotificationsPending = false;
        notificationLedger.clear();
    }

    private String credentialFingerprint(String normalizedServerUrl) {
        if (normalizedServerUrl.isEmpty()) return "";
        try {
            String token = SecureTokenPlugin.readStoredValue(context, TOKEN_KEY);
            if (token == null || token.isEmpty()) return "";
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] value = (normalizedServerUrl + "\0" + token).getBytes(StandardCharsets.UTF_8);
            return Base64.encodeToString(digest.digest(value), Base64.NO_WRAP);
        } catch (Exception ignored) {
            return "";
        }
    }

    private synchronized void connect() {
        if (stopped || serverUrl.isEmpty() || socket != null) return;
        try {
            String token = SecureTokenPlugin.readStoredValue(context, TOKEN_KEY);
            if (token == null || token.isEmpty()) {
                scheduleReconnect();
                return;
            }
            String wsUrl = websocketUrl(serverUrl);
            String encodedToken = Base64.encodeToString(
                    token.getBytes(StandardCharsets.UTF_8),
                    Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            Request request = new Request.Builder()
                    .url(wsUrl)
                    .header("Sec-WebSocket-Protocol", WIRE_PROTOCOL + ", token." + encodedToken)
                    .build();
            long epoch = ++socketEpoch;
            socket = client.newWebSocket(request, new Listener(epoch));
        } catch (Exception ignored) {
            scheduleReconnect();
        }
    }

    private static String websocketUrl(String raw) throws Exception {
        String value = raw.matches("^[A-Za-z][A-Za-z0-9+.-]*://.*") ? raw : "http://" + raw;
        URI uri = new URI(value);
        String scheme = "https".equalsIgnoreCase(uri.getScheme()) || "wss".equalsIgnoreCase(uri.getScheme()) ? "wss" : "ws";
        return new URI(scheme, uri.getUserInfo(), uri.getHost(), uri.getPort(), "/ws", null, null).toString();
    }

    private synchronized void scheduleReconnect() {
        if (stopped || socket != null) return;
        reconnectAttempts += 1;
        long delay = Math.min(MAX_RECONNECT_MS, 800L << Math.min(reconnectAttempts - 1, 5));
        handler.removeCallbacks(reconnectRunnable);
        handler.postDelayed(reconnectRunnable, delay);
    }

    private final Runnable reconnectRunnable = () -> {
        synchronized (CodexBackgroundSocket.this) {
            if (stopped || socket != null) return;
            connect();
        }
    };

    private synchronized boolean isCurrent(WebSocket webSocket, long epoch) {
        return !stopped && socketEpoch == epoch && socket == webSocket;
    }

    private synchronized void disconnected(WebSocket webSocket, long epoch) {
        if (!isCurrent(webSocket, epoch)) return;
        socket = null;
        scheduleReconnect();
    }

    private final class Listener extends WebSocketListener {
        private final long epoch;

        Listener(long epoch) {
            this.epoch = epoch;
        }

        @Override
        public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
            if (!isCurrent(webSocket, epoch)) return;
            synchronized (CodexBackgroundSocket.this) {
                if (!isCurrent(webSocket, epoch)) return;
                reconnectAttempts = 0;
                handler.removeCallbacks(reconnectRunnable);
            }
        }

        @Override
        public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            try {
                Object payload = text.trim().startsWith("[") ? new JSONArray(text) : new JSONObject(text);
                synchronized (CodexBackgroundSocket.this) {
                    if (!isCurrent(webSocket, epoch)) return;
                    if (payload instanceof JSONArray) {
                        JSONArray messages = (JSONArray) payload;
                        for (int index = 0; index < messages.length(); index += 1) handle(messages.optJSONObject(index));
                    } else {
                        handle((JSONObject) payload);
                    }
                }
            } catch (JSONException ignored) {
                // A malformed non-protocol message must not terminate the foreground listener.
            }
        }

        @Override
        public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            disconnected(webSocket, epoch);
        }

        @Override
        public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable error, Response response) {
            disconnected(webSocket, epoch);
        }
    }

    private void handle(JSONObject message) {
        if (message == null) return;
        String type = message.optString("type", "");
        switch (type) {
            case "welcome":
                WebSocket active = socket;
                if (active != null) active.send("{\"type\":\"threads.list\",\"requestId\":\"android-background-welcome\"}");
                break;
            case "threads":
            case "threads.snapshot":
                handleFullThreads(message.optJSONArray("threads"));
                break;
            case "threads.delta":
                handleRemoved(message.optJSONArray("removedIds"));
                handleThreads(message.optJSONArray("upserts"));
                break;
            case "thread":
                handleThread(message.optJSONObject("thread"));
                break;
            case "approval":
                handleApproval(message.optJSONObject("approval"));
                break;
            case "approval.resolved":
                handleApprovalResolved(String.valueOf(message.opt("approvalRequestId")));
                break;
            case "turn.completed":
                handleTurnCompleted(message.optString("threadId", ""), message.optJSONObject("turn"));
                break;
            case "event":
                handleEvent(message.optString("method", ""), message.optJSONObject("params"));
                break;
            default:
                break;
        }
    }

    private void handleFullThreads(JSONArray threads) {
        if (threads == null) return;
        clearRecoveredNotificationsBeforeSnapshot();
        Set<String> nextIds = new HashSet<>();
        for (int index = 0; index < threads.length(); index += 1) {
            JSONObject thread = threads.optJSONObject(index);
            String threadId = firstString(thread, "id", "threadId");
            if (!threadId.isEmpty()) nextIds.add(threadId);
            handleThread(thread);
        }
        for (String previousId : new HashSet<>(knownThreadIds)) {
            if (!nextIds.contains(previousId)) clearThreadState(previousId);
        }
        knownThreadIds.clear();
        knownThreadIds.addAll(nextIds);
    }

    private synchronized void clearRecoveredNotificationsBeforeSnapshot() {
        if (!recoveredNotificationsPending) return;
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (String requestId : new HashSet<>(recoveredApprovalEntries.keySet())) {
            int id = notificationId("approval:" + requestId);
            manager.cancel(id);
            notificationLedger.removeApproval(requestId);
            notificationLedger.removeNotification(id);
        }
        for (Map.Entry<String, String> entry : new HashSet<>(recoveredAttentionEntries.entrySet())) {
            int id = notificationId("attention:" + entry.getValue() + ":" + entry.getKey());
            manager.cancel(id);
            notificationLedger.removeAttention(entry.getKey());
            notificationLedger.removeNotification(id);
        }
        for (String persistedId : new HashSet<>(recoveredNotificationEntries.keySet())) {
            try {
                int id = Integer.parseInt(persistedId);
                manager.cancel(id);
                notificationLedger.removeNotification(id);
            } catch (NumberFormatException ignored) { }
        }
        recoveredApprovalEntries.clear();
        recoveredAttentionEntries.clear();
        recoveredNotificationEntries.clear();
        recoveredNotificationsPending = false;
    }

    private synchronized void markRecoveredApprovalCurrent(String requestId) {
        if (recoveredApprovalEntries.remove(requestId) == null) return;
        int id = notificationId("approval:" + requestId);
        recoveredNotificationEntries.remove(String.valueOf(id));
        NotificationManagerCompat.from(context).cancel(id);
        notificationLedger.removeApproval(requestId);
        notificationLedger.removeNotification(id);
    }

    private synchronized void markRecoveredAttentionCurrent(String threadId) {
        String recoveredState = recoveredAttentionEntries.remove(threadId);
        if (recoveredState == null) return;
        int id = notificationId("attention:" + recoveredState + ":" + threadId);
        recoveredNotificationEntries.remove(String.valueOf(id));
        NotificationManagerCompat.from(context).cancel(id);
        notificationLedger.removeAttention(threadId);
        notificationLedger.removeNotification(id);
    }

    private void handleThreads(JSONArray threads) {
        if (threads == null) return;
        for (int index = 0; index < threads.length(); index += 1) handleThread(threads.optJSONObject(index));
    }

    private void handleRemoved(JSONArray removedIds) {
        if (removedIds == null) return;
        for (int index = 0; index < removedIds.length(); index += 1) clearThreadState(removedIds.optString(index, ""));
    }

    private void handleThread(JSONObject thread) {
        if (thread == null) return;
        String threadId = firstString(thread, "id", "threadId");
        if (threadId.isEmpty()) return;
        knownThreadIds.add(threadId);
        String title = firstString(thread, "name", "title", "preview");
        if (!title.isEmpty()) threadTitles.put(threadId, title);
        Object rawStatus = thread.opt("threadRuntimeStatus");
        if (rawStatus == null || rawStatus == JSONObject.NULL) rawStatus = thread.opt("status");
        String state = stateFromStatus(rawStatus);
        observeThreadState(threadId, state);
    }

    private void handleEvent(String method, JSONObject params) {
        if (params == null) return;
        String threadId = firstString(params, "threadId", "conversationId");
        if ("thread/status/changed".equals(method)) {
            observeThreadState(threadId, stateFromStatus(params.opt("status")));
        } else if ("turn/completed".equals(method)) {
            handleTurnCompleted(threadId, params.optJSONObject("turn"));
        } else if (("thread/started".equals(method) || "desktop/threadSnapshot".equals(method)) && params.optJSONObject("thread") != null) {
            handleThread(params.optJSONObject("thread"));
        }
    }

    private synchronized void handleApproval(JSONObject approval) {
        if (approval == null) return;
        String requestId = String.valueOf(approval.opt("requestId"));
        if (requestId.isEmpty() || "null".equals(requestId)) return;
        markRecoveredApprovalCurrent(requestId);
        String threadId = approval.optString("threadId", "global");
        approvalTracker.add(requestId, threadId);
        if (notifiedApprovalIds.contains(requestId)) notificationLedger.putApproval(requestId, threadId);
        cancelAttentionTimer(threadId);
        desiredAttention.put(threadId, "approval");
        String coarse = notifiedAttention.remove(threadId);
        if (coarse != null) cancelAttentionNotification(threadId, coarse);
        if (notifiedApprovalIds.contains(requestId)) return;

        String method = approval.optString("method", "");
        String title = method.contains("mcpServer/elicitation") ? "Codex 等待 Computer Use 确认"
                : method.contains("fileChange") ? "Codex 等待文件修改确认"
                : method.contains("permissions") ? "Codex 请求额外权限" : "Codex 等待命令确认";
        String text = firstString(approval, "command", "reason", "detail", "title");
        if (text.isEmpty()) text = "打开 App 查看详情并确认。";
        int id = notificationId("approval:" + requestId);
        if (!notificationLedger.claimNotification(id, threadId)) {
            notifiedApprovalIds.add(requestId);
            notificationLedger.putApproval(requestId, threadId);
            return;
        }
        if (post(id, CodexNotificationChannels.APPROVALS,
                "approval", threadId, "openApproval", title, text)) {
            notifiedApprovalIds.add(requestId);
            notificationLedger.putApproval(requestId, threadId);
        } else {
            notificationLedger.removeNotification(id);
        }
    }

    private synchronized void handleApprovalResolved(String requestId) {
        recoveredApprovalEntries.remove(requestId);
        int id = notificationId("approval:" + requestId);
        recoveredNotificationEntries.remove(String.valueOf(id));
        NotificationManagerCompat.from(context).cancel(id);
        notifiedApprovalIds.remove(requestId);
        notificationLedger.removeApproval(requestId);
        notificationLedger.removeNotification(id);
        String threadId = approvalTracker.remove(requestId);
        if (threadId == null) return;
        if (!approvalTracker.hasThread(threadId)) clearCoarseAttention(threadId);
        else desiredAttention.put(threadId, "approval");
    }

    private synchronized void handleTurnCompleted(String threadId, JSONObject turn) {
        if (threadId == null || threadId.isEmpty()) return;
        cancelCompletionFallback(threadId);
        String status = turn == null ? "completed" : turn.optString("status", "completed").toLowerCase(Locale.ROOT);
        threadStates.put(threadId, status.contains("fail") ? "error" : "idle");
        long now = android.os.SystemClock.elapsedRealtime();
        Long previousCompletion = lastCompletionAt.get(threadId);
        if (previousCompletion != null && now - previousCompletion < COMPLETION_DEDUPE_MS) return;
        lastCompletionAt.put(threadId, now);
        clearPendingAttention(threadId);
        String title = status.contains("fail") ? "Codex 执行失败"
                : status.contains("interrupt") ? "Codex 已中断" : "Codex 已完成";
        String eventId = turn == null ? "latest" : firstString(turn, "id", "turnId", "completedAt", "startedAt");
        if (eventId.isEmpty()) eventId = "latest";
        String threadTitle = threadTitles.getOrDefault(threadId, "Codex 任务");
        post(notificationId("turn:" + threadId + ":" + eventId), CodexNotificationChannels.COMPLETIONS,
                "completion", threadId, "openThread", title, threadTitle);
    }

    private synchronized void observeThreadState(String threadId, String state) {
        if (threadId == null || threadId.isEmpty() || "unknown".equals(state)) return;
        String previous = threadStates.put(threadId, state);
        updateAttention(threadId, state);
        if (isActiveState(state)) {
            cancelCompletionFallback(threadId);
            return;
        }
        if (isActiveState(previous) && isTerminalState(state)) scheduleCompletionFallback(threadId, state);
    }

    private synchronized void scheduleCompletionFallback(String threadId, String state) {
        cancelCompletionFallback(threadId);
        Runnable fallback = () -> {
            synchronized (CodexBackgroundSocket.this) {
                completionTimers.remove(threadId);
                if (!state.equals(threadStates.get(threadId)) || !isTerminalState(state)) return;
                JSONObject syntheticTurn = new JSONObject();
                try {
                    syntheticTurn.put("id", "status-" + System.currentTimeMillis());
                    syntheticTurn.put("status", "error".equals(state) ? "failed" : "completed");
                } catch (JSONException ignored) { }
                handleTurnCompleted(threadId, syntheticTurn);
            }
        };
        completionTimers.put(threadId, fallback);
        handler.postDelayed(fallback, COMPLETION_FALLBACK_DELAY_MS);
    }

    private synchronized void cancelCompletionFallback(String threadId) {
        Runnable fallback = completionTimers.remove(threadId);
        if (fallback != null) handler.removeCallbacks(fallback);
    }

    private static boolean isActiveState(String state) {
        return "running".equals(state) || "approval".equals(state) || "input".equals(state);
    }

    private static boolean isTerminalState(String state) {
        return "idle".equals(state) || "error".equals(state);
    }

    private synchronized void updateAttention(String threadId, String state) {
        if (threadId == null || threadId.isEmpty()) return;
        if ("approval".equals(state) || "input".equals(state)) markRecoveredAttentionCurrent(threadId);
        if (!"approval".equals(state) && !"input".equals(state)) {
            clearPendingAttention(threadId);
            return;
        }
        if ("input".equals(state)) clearApprovalsForThread(threadId);
        String previous = desiredAttention.put(threadId, state);
        if ("approval".equals(state) && approvalTracker.hasThread(threadId)) {
            cancelAttentionTimer(threadId);
            return;
        }
        if (state.equals(previous) && (attentionTimers.containsKey(threadId) || state.equals(notifiedAttention.get(threadId)))) return;
        cancelAttentionTimer(threadId);
        String notified = notifiedAttention.get(threadId);
        if (notified != null && !notified.equals(state)) {
            cancelAttentionNotification(threadId, notified);
            notifiedAttention.remove(threadId);
        }
        Runnable show = () -> {
            synchronized (CodexBackgroundSocket.this) {
                attentionTimers.remove(threadId);
                if (!state.equals(desiredAttention.get(threadId))) return;
                if ("approval".equals(state) && approvalTracker.hasThread(threadId)) return;
                String title = "input".equals(state) ? "Codex 等待你的输入" : "Codex 等待审批";
                String text = threadTitles.getOrDefault(threadId, "Codex 任务") + " · 打开 App 继续处理。";
                if (post(notificationId("attention:" + state + ":" + threadId),
                        "input".equals(state) ? CodexNotificationChannels.INPUTS : CodexNotificationChannels.APPROVALS,
                        "approval", threadId, "input".equals(state) ? "openThread" : "openApproval", title, text)) {
                    notifiedAttention.put(threadId, state);
                    notificationLedger.putAttention(threadId, state);
                }
            }
        };
        attentionTimers.put(threadId, show);
        handler.postDelayed(show, "approval".equals(state) ? 2_000L : 250L);
    }

    private synchronized void clearPendingAttention(String threadId) {
        clearCoarseAttention(threadId);
        clearApprovalsForThread(threadId);
        cancelPersistedNotificationsForThread(threadId);
    }

    private synchronized void clearCoarseAttention(String threadId) {
        if (threadId == null || threadId.isEmpty()) return;
        cancelAttentionTimer(threadId);
        desiredAttention.remove(threadId);
        notifiedAttention.remove(threadId);
        // Both deterministic IDs are safe to cancel. This also removes notifications
        // restored from the durable ledger after a process restart.
        cancelAttentionNotification(threadId, "approval");
        cancelAttentionNotification(threadId, "input");
        notificationLedger.removeAttention(threadId);
    }

    private synchronized void clearApprovalsForThread(String threadId) {
        Set<String> requestIds = approvalTracker.removeThread(threadId);
        if (requestIds.isEmpty()) return;
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (String requestId : requestIds) {
            notifiedApprovalIds.remove(requestId);
            notificationLedger.removeApproval(requestId);
            int id = notificationId("approval:" + requestId);
            notificationLedger.removeNotification(id);
            manager.cancel(id);
        }
    }

    private synchronized void clearThreadState(String threadId) {
        if (threadId == null || threadId.isEmpty()) return;
        clearPendingAttention(threadId);
        knownThreadIds.remove(threadId);
        threadTitles.remove(threadId);
        threadStates.remove(threadId);
        lastCompletionAt.remove(threadId);
        cancelCompletionFallback(threadId);
    }

    private void cancelPersistedNotificationsForThread(String threadId) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (Map.Entry<String, String> entry : notificationLedger.notificationIds().entrySet()) {
            if (!threadId.equals(entry.getValue())) continue;
            try {
                int id = Integer.parseInt(entry.getKey());
                manager.cancel(id);
                notificationLedger.removeNotification(id);
            } catch (NumberFormatException ignored) { }
        }
    }

    private void cancelAttentionTimer(String threadId) {
        Runnable timer = attentionTimers.remove(threadId);
        if (timer != null) handler.removeCallbacks(timer);
    }

    private void cancelAttentionNotification(String threadId, String state) {
        int id = notificationId("attention:" + state + ":" + threadId);
        NotificationManagerCompat.from(context).cancel(id);
        notificationLedger.removeAttention(threadId);
        notificationLedger.removeNotification(id);
    }

    private boolean post(int id, String channel, String kind, String threadId, String action, String title, String text) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        CodexNotificationChannels.ensureCreated(context);
        Intent activityIntent = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        NotificationActionStore.decorate(activityIntent, threadId, action, kind);
        PendingIntent contentIntent = PendingIntent.getActivity(
                context,
                CodexBackgroundService.requestCode(kind, threadId, action),
                activityIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_codex_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setOnlyAlertOnce(false)
                .setGroup("codex-thread-" + threadId);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
        }
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
            CodexNotificationChannels.playVendorAlertFallback(context, alertKindForChannel(channel));
            if ("approval".equals(kind)) notificationLedger.putNotification(id, threadId);
            return true;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String alertKindForChannel(String channel) {
        if (CodexNotificationChannels.APPROVALS.equals(channel)) return "approval";
        if (CodexNotificationChannels.INPUTS.equals(channel)) return "input";
        return "completion";
    }

    private static String stateFromStatus(Object raw) {
        if (raw instanceof JSONObject) {
            JSONObject status = (JSONObject) raw;
            JSONArray flags = status.optJSONArray("activeFlags");
            if (flags != null) {
                for (int index = 0; index < flags.length(); index += 1) {
                    String flag = flags.optString(index, "");
                    if ("waitingOnApproval".equals(flag)) return "approval";
                    if ("waitingOnUserInput".equals(flag)) return "input";
                }
            }
            raw = status.opt("type");
            if (raw == null || raw == JSONObject.NULL) raw = status.opt("status");
        }
        String text = raw == null ? "" : String.valueOf(raw).toLowerCase(Locale.ROOT);
        if (text.contains("waitingonapproval") || text.contains("waiting_approval")) return "approval";
        if (text.contains("waitingonuserinput") || text.contains("waiting_input")) return "input";
        if (text.contains("progress") || text.contains("running") || text.contains("active")) return "running";
        if (text.contains("error") || text.contains("fail")) return "error";
        if (text.contains("idle") || text.contains("complete")) return "idle";
        return "unknown";
    }

    private static String firstString(JSONObject object, String... keys) {
        if (object == null) return "";
        for (String key : keys) {
            Object value = object.opt(key);
            if (value != null && value != JSONObject.NULL) {
                String text = String.valueOf(value).trim();
                if (!text.isEmpty()) return text;
            }
        }
        return "";
    }

    static int notificationId(String key) {
        int hash = key.hashCode();
        if (hash == Integer.MIN_VALUE) return 1;
        hash = Math.abs(hash);
        return hash == 0 ? 1 : hash;
    }
}
