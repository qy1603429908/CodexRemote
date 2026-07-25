package dev.codexmobile.remote;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;

@CapacitorPlugin(name = "CodexFileTransfer")
public class CodexFileTransferPlugin extends Plugin {
    @PluginMethod
    public void download(PluginCall call) {
        String serverUrl = call.getString("serverUrl");
        String token = call.getString("token");
        String ticketId = call.getString("ticketId");
        if (serverUrl == null || token == null || ticketId == null || !ticketId.matches("[A-Za-z0-9_-]{22,128}")) {
            call.reject("Invalid download arguments");
            return;
        }
        new Thread(() -> downloadOnWorker(call, serverUrl, token, ticketId), "codex-file-download").start();
    }

    private void downloadOnWorker(PluginCall call, String serverUrl, String token, String ticketId) {
        HttpURLConnection connection = null;
        Uri outputUri = null;
        File legacyFile = null;
        try {
            String base = serverUrl.replaceAll("/+$", "");
            connection = (HttpURLConnection) new URL(base + "/api/files/download/" + ticketId).openConnection();
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(120_000);
            connection.setUseCaches(false);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("Download failed (HTTP " + status + ")");

            String fileName = responseFileName(connection.getHeaderField("Content-Disposition"), "codex-download-" + ticketId.substring(0, 8));
            String mimeType = connection.getContentType();
            if (mimeType == null || mimeType.isBlank()) mimeType = "application/octet-stream";
            long bytes;
            ContentResolver resolver = getContext().getContentResolver();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Codex Remote");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                outputUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (outputUri == null) throw new IllegalStateException("Unable to create Downloads entry");
                try (InputStream input = connection.getInputStream(); OutputStream output = resolver.openOutputStream(outputUri, "w")) {
                    if (output == null) throw new IllegalStateException("Unable to open Downloads output");
                    bytes = copy(input, output);
                }
                ContentValues completed = new ContentValues();
                completed.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(outputUri, completed, null, null);
            } else {
                File directory = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Codex Remote");
                if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Unable to create download directory");
                legacyFile = uniqueFile(directory, fileName);
                try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(legacyFile)) {
                    bytes = copy(input, output);
                }
                outputUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", legacyFile);
            }

            JSObject result = new JSObject();
            result.put("uri", outputUri.toString());
            result.put("fileName", fileName);
            result.put("mimeType", mimeType);
            result.put("size", bytes);
            call.resolve(result);
        } catch (Exception error) {
            if (outputUri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                getContext().getContentResolver().delete(outputUri, null, null);
            }
            if (legacyFile != null) legacyFile.delete();
            call.reject(error.getMessage() == null ? "File download failed" : error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static long copy(InputStream input, OutputStream output) throws Exception {
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        int read;
        while ((read = input.read(buffer)) >= 0) {
            output.write(buffer, 0, read);
            total += read;
        }
        output.flush();
        return total;
    }

    private static String responseFileName(String disposition, String fallback) {
        if (disposition == null) return fallback;
        int encodedIndex = disposition.toLowerCase().indexOf("filename*=utf-8''");
        if (encodedIndex >= 0) {
            String value = disposition.substring(encodedIndex + 17).split(";", 2)[0];
            try { return sanitize(URLDecoder.decode(value, "UTF-8")); } catch (Exception ignored) { }
        }
        int quotedIndex = disposition.toLowerCase().indexOf("filename=\"");
        if (quotedIndex >= 0) {
            String value = disposition.substring(quotedIndex + 10);
            int end = value.indexOf('"');
            if (end >= 0) return sanitize(value.substring(0, end));
        }
        return fallback;
    }

    private static String sanitize(String name) {
        String safe = name.replaceAll("[\\\\/\\x00-\\x1f\\x7f]", "_").trim();
        return safe.isEmpty() ? "codex-download" : safe;
    }

    private static File uniqueFile(File directory, String name) {
        File file = new File(directory, name);
        if (!file.exists()) return file;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int index = 2; index < 10_000; index++) {
            file = new File(directory, stem + " (" + index + ")" + extension);
            if (!file.exists()) return file;
        }
        return new File(directory, System.currentTimeMillis() + "-" + name);
    }
}
