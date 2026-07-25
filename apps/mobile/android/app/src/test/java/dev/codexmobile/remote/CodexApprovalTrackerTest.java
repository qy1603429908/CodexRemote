package dev.codexmobile.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Set;

public class CodexApprovalTrackerTest {
    @Test
    public void resolvingOneApprovalKeepsOtherApprovalPending() {
        CodexApprovalTracker tracker = new CodexApprovalTracker();
        tracker.add("approval-a", "thread");
        tracker.add("approval-b", "thread");

        assertEquals("thread", tracker.remove("approval-a"));
        assertTrue(tracker.hasThread("thread"));
        assertEquals(Set.of("approval-b"), tracker.requestIds());
    }

    @Test
    public void removingThreadClearsEveryApproval() {
        CodexApprovalTracker tracker = new CodexApprovalTracker();
        tracker.add("approval-a", "thread");
        tracker.add("approval-b", "thread");

        assertEquals(Set.of("approval-a", "approval-b"), tracker.removeThread("thread"));
        assertFalse(tracker.hasThread("thread"));
        assertTrue(tracker.requestIds().isEmpty());
    }

    @Test
    public void movingRequestToAnotherThreadDoesNotLeaveGhostState() {
        CodexApprovalTracker tracker = new CodexApprovalTracker();
        tracker.add("approval", "old-thread");
        tracker.add("approval", "new-thread");

        assertFalse(tracker.hasThread("old-thread"));
        assertTrue(tracker.hasThread("new-thread"));
        assertEquals("new-thread", tracker.remove("approval"));
    }
}
