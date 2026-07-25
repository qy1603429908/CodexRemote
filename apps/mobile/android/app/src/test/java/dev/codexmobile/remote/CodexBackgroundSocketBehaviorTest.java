package dev.codexmobile.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.concurrent.TimeUnit;

import static org.robolectric.Shadows.shadowOf;

import java.lang.reflect.Method;
import java.util.Map;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class CodexBackgroundSocketBehaviorTest {
    private Context context;
    private CodexNotificationLedger ledger;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        ledger = new CodexNotificationLedger(context);
        ledger.clear();
    }

    @After
    public void tearDown() {
        ledger.clear();
    }

    @Test
    public void restoredNotificationIndexIsClearedByFirstFullSnapshot() throws Exception {
        ledger.setFingerprint("same-session");
        ledger.putApproval("approval-a", "thread-a");
        ledger.putAttention("thread-b", "approval");

        CodexBackgroundSocket socket = new CodexBackgroundSocket(context);
        invoke(socket, "handleFullThreads", new Class<?>[] { JSONArray.class }, new JSONArray());

        assertTrue(ledger.approvals().isEmpty());
        assertTrue(ledger.attentions().isEmpty());
    }

    @Test
    public void processRecoveryDropsStaleRequestIdsAndRecreatesOnlyCurrentCoarseWaitingState() throws Exception {
        int approvalA = CodexBackgroundSocket.notificationId("approval:approval-a");
        int approvalB = CodexBackgroundSocket.notificationId("approval:approval-b");
        ledger.setFingerprint("same-session");
        ledger.putApproval("approval-a", "thread");
        ledger.putApproval("approval-b", "thread");
        ledger.putNotification(approvalA, "thread");
        ledger.putNotification(approvalB, "thread");

        CodexBackgroundSocket socket = new CodexBackgroundSocket(context);
        JSONObject status = new JSONObject()
                .put("type", "active")
                .put("activeFlags", new JSONArray().put("waitingOnApproval"));
        JSONArray snapshot = new JSONArray().put(new JSONObject()
                .put("id", "thread")
                .put("title", "Task")
                .put("threadRuntimeStatus", status));
        invoke(socket, "handleFullThreads", new Class<?>[] { JSONArray.class }, snapshot);

        assertTrue(ledger.approvals().isEmpty());
        assertTrue(ledger.notificationIds().isEmpty());
        shadowOf(Looper.getMainLooper()).idleFor(2, TimeUnit.SECONDS);
        assertEquals(Map.of("thread", "approval"), ledger.attentions());
        assertEquals(Map.of(
                String.valueOf(CodexBackgroundSocket.notificationId("attention:approval:thread")), "thread"
        ), ledger.notificationIds());
    }

    @Test
    public void realtimeApprovalBeforeFirstSnapshotSurvivesRecoveredCleanup() throws Exception {
        int oldId = CodexBackgroundSocket.notificationId("approval:approval-a");
        ledger.setFingerprint("same-session");
        ledger.putApproval("approval-a", "thread");
        ledger.putNotification(oldId, "thread");

        CodexBackgroundSocket socket = new CodexBackgroundSocket(context);
        invoke(socket, "handleApproval", new Class<?>[] { JSONObject.class }, approval("approval-b", "thread"));
        JSONObject status = new JSONObject()
                .put("type", "active")
                .put("activeFlags", new JSONArray().put("waitingOnApproval"));
        JSONArray snapshot = new JSONArray().put(new JSONObject()
                .put("id", "thread")
                .put("threadRuntimeStatus", status));
        invoke(socket, "handleFullThreads", new Class<?>[] { JSONArray.class }, snapshot);

        assertEquals(Map.of("approval-b", "thread"), ledger.approvals());
        assertEquals(Map.of(
                String.valueOf(CodexBackgroundSocket.notificationId("approval:approval-b")), "thread"
        ), ledger.notificationIds());
    }

    @Test
    public void realtimeInputBeforeFirstSnapshotSurvivesRecoveredCleanup() throws Exception {
        int oldId = CodexBackgroundSocket.notificationId("attention:approval:thread");
        ledger.setFingerprint("same-session");
        ledger.putAttention("thread", "approval");
        ledger.putNotification(oldId, "thread");

        CodexBackgroundSocket socket = new CodexBackgroundSocket(context);
        invoke(socket, "updateAttention", new Class<?>[] { String.class, String.class }, "thread", "input");
        shadowOf(Looper.getMainLooper()).idleFor(250, TimeUnit.MILLISECONDS);
        JSONObject status = new JSONObject()
                .put("type", "active")
                .put("activeFlags", new JSONArray().put("waitingOnUserInput"));
        JSONArray snapshot = new JSONArray().put(new JSONObject()
                .put("id", "thread")
                .put("threadRuntimeStatus", status));
        invoke(socket, "handleFullThreads", new Class<?>[] { JSONArray.class }, snapshot);

        assertEquals(Map.of("thread", "input"), ledger.attentions());
        assertEquals(Map.of(
                String.valueOf(CodexBackgroundSocket.notificationId("attention:input:thread")), "thread"
        ), ledger.notificationIds());
    }

    @Test
    public void credentialSessionResetCannotCarryRecoveredIdsIntoTheNewSession() throws Exception {
        int oldId = CodexBackgroundSocket.notificationId("approval:shared-request");
        ledger.setFingerprint("old-session");
        ledger.putApproval("shared-request", "old-thread");
        ledger.putNotification(oldId, "old-thread");

        CodexBackgroundSocket socket = new CodexBackgroundSocket(context);
        invoke(socket, "clearSessionState", new Class<?>[] {});
        invoke(socket, "handleApproval", new Class<?>[] { JSONObject.class }, approval("shared-request", "new-thread"));
        JSONObject status = new JSONObject()
                .put("type", "active")
                .put("activeFlags", new JSONArray().put("waitingOnApproval"));
        JSONArray snapshot = new JSONArray().put(new JSONObject()
                .put("id", "new-thread")
                .put("threadRuntimeStatus", status));
        invoke(socket, "handleFullThreads", new Class<?>[] { JSONArray.class }, snapshot);

        assertEquals(Map.of("shared-request", "new-thread"), ledger.approvals());
        assertEquals(Map.of(String.valueOf(oldId), "new-thread"), ledger.notificationIds());
    }

    @Test
    public void resolvingOneApprovalKeepsTheOtherInTheDurableSocketState() throws Exception {
        CodexBackgroundSocket socket = new CodexBackgroundSocket(context);
        invoke(socket, "handleApproval", new Class<?>[] { JSONObject.class }, approval("approval-a", "thread"));
        invoke(socket, "handleApproval", new Class<?>[] { JSONObject.class }, approval("approval-b", "thread"));
        invoke(socket, "handleApprovalResolved", new Class<?>[] { String.class }, "approval-a");

        assertEquals(Map.of("approval-b", "thread"), ledger.approvals());
    }

    private static JSONObject approval(String requestId, String threadId) throws Exception {
        return new JSONObject()
                .put("requestId", requestId)
                .put("threadId", threadId)
                .put("method", "permissions")
                .put("reason", "test");
    }

    private static Object invoke(Object target, String name, Class<?>[] parameterTypes, Object... args) throws Exception {
        Method method = target.getClass().getDeclaredMethod(name, parameterTypes);
        method.setAccessible(true);
        return method.invoke(target, args);
    }
}
