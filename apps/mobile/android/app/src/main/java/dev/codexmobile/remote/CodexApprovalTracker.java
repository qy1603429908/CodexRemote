package dev.codexmobile.remote;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class CodexApprovalTracker {
    private final Map<String, String> requestThreads = new ConcurrentHashMap<>();
    private final Map<String, Set<String>> threadRequests = new ConcurrentHashMap<>();

    void add(String requestId, String threadId) {
        String previousThread = requestThreads.put(requestId, threadId);
        if (previousThread != null && !previousThread.equals(threadId)) removeFromThread(previousThread, requestId);
        threadRequests.computeIfAbsent(threadId, ignored -> ConcurrentHashMap.newKeySet()).add(requestId);
    }

    String remove(String requestId) {
        String threadId = requestThreads.remove(requestId);
        if (threadId != null) removeFromThread(threadId, requestId);
        return threadId;
    }

    Set<String> removeThread(String threadId) {
        Set<String> removed = threadRequests.remove(threadId);
        if (removed == null) return Set.of();
        Set<String> snapshot = new HashSet<>(removed);
        for (String requestId : snapshot) requestThreads.remove(requestId, threadId);
        return snapshot;
    }

    boolean hasThread(String threadId) {
        Set<String> requests = threadRequests.get(threadId);
        return requests != null && !requests.isEmpty();
    }

    Set<String> requestIds() {
        return new HashSet<>(requestThreads.keySet());
    }

    void clear() {
        requestThreads.clear();
        threadRequests.clear();
    }

    private void removeFromThread(String threadId, String requestId) {
        Set<String> requests = threadRequests.get(threadId);
        if (requests == null) return;
        requests.remove(requestId);
        if (requests.isEmpty()) threadRequests.remove(threadId, requests);
    }
}
