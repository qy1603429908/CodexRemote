package dev.codexmobile.remote;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class CodexBackgroundSocketTest {
    @Test
    public void notificationIdsMatchWebViewHashForAsciiAndUnicode() {
        assertEquals(223193211, CodexBackgroundSocket.notificationId("approval:123"));
        assertEquals(2017451920, CodexBackgroundSocket.notificationId("turn:thread:turn"));
        assertEquals(2019956927, CodexBackgroundSocket.notificationId("attention:approval:任务"));
        assertEquals(1397803963, CodexBackgroundSocket.notificationId("turn:任务:完成"));
    }

    @Test
    public void integerMinHashUsesSafePositiveId() {
        assertEquals(1, CodexBackgroundSocket.notificationId("polygenelubricants"));
    }
}
