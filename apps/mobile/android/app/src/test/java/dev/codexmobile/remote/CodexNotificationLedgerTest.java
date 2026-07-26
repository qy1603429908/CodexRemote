package dev.codexmobile.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.LinkedHashMap;
import java.util.Map;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class CodexNotificationLedgerTest {
    @Test
    public void notificationIndexRoundTripsUnicodeIdsAndThreadMappings() {
        Map<String, String> values = new LinkedHashMap<>();
        values.put("request-1", "thread-1");
        values.put("审批-2", "任务-2");

        assertEquals(values, CodexNotificationLedger.decodeMap(CodexNotificationLedger.encodeMap(values)));
    }

    @Test
    public void corruptOrEmptyLedgerDoesNotBlockServiceRecovery() {
        assertTrue(CodexNotificationLedger.decodeMap("").isEmpty());
        assertTrue(CodexNotificationLedger.decodeMap("not-json").isEmpty());
    }

    @Test
    public void notificationClaimIsSharedAcrossForegroundAndBackgroundLedgerInstances() {
        android.content.Context context = androidx.test.core.app.ApplicationProvider.getApplicationContext();
        CodexNotificationLedger foreground = new CodexNotificationLedger(context);
        CodexNotificationLedger background = new CodexNotificationLedger(context);
        foreground.clear();

        assertTrue(background.claimNotification(123, "thread-a"));
        assertFalse(foreground.claimNotification(123, "thread-a"));
        assertEquals(Map.of("123", "thread-a"), foreground.notificationIds());

        foreground.removeNotification(123);
        assertTrue(foreground.claimNotification(123, "thread-a"));
        foreground.clear();
    }

    @Test
    public void exactNotificationIdsRemainAssociatedWithTheirThread() {
        android.content.Context context = androidx.test.core.app.ApplicationProvider.getApplicationContext();
        CodexNotificationLedger ledger = new CodexNotificationLedger(context);
        ledger.clear();
        ledger.putNotification(123, "thread-a");
        ledger.putNotification(456, "thread-b");
        assertEquals(Map.of("123", "thread-a", "456", "thread-b"), ledger.notificationIds());
        ledger.removeNotification(123);
        assertEquals(Map.of("456", "thread-b"), ledger.notificationIds());
        ledger.clear();
    }
}
