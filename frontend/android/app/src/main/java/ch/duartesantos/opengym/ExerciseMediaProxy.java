package ch.duartesantos.opengym;

import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Proxies on-demand exercise media requests (/exercise-media/still/* and /exercise-media/clip/*)
 * from the remote Rit server and caches each file on local app cache storage.
 *
 * Serving through the local WebView origin avoids shipping ~190 MB of media inside the APK while
 * keeping same-origin loading intact even when the remote server enforces
 * Cross-Origin-Resource-Policy: same-origin, and provides automatic offline playback once cached.
 */
final class ExerciseMediaProxy {
    static final String DEFAULT_REMOTE_BASE = "https://app.treinerit.duckdns.org";
    static final int MAX_FILE_BYTES = 10 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 15000;
    private static final Pattern VALID_PATH = Pattern.compile(
            "^/exercise-media/(still|clip)/[A-Za-z0-9_-]+\\.(webp|mp4|gif|png|jpg)$"
    );

    interface Fetcher {
        /** Returns bytes on HTTP 200, null on HTTP 404/410, or throws IOException on failure. */
        byte[] fetch(String url) throws IOException;
    }

    private final File cacheRoot;
    private final String remoteBase;
    private final Fetcher fetcher;

    ExerciseMediaProxy(File cacheRoot) {
        this(cacheRoot, DEFAULT_REMOTE_BASE, ExerciseMediaProxy::httpFetch);
    }

    ExerciseMediaProxy(File cacheRoot, String remoteBase, Fetcher fetcher) {
        this.cacheRoot = cacheRoot;
        this.remoteBase = stripTrailingSlash(remoteBase == null || remoteBase.isEmpty() ? DEFAULT_REMOTE_BASE : remoteBase);
        this.fetcher = fetcher;
    }

    static boolean isValidMediaPath(String path) {
        return path != null && VALID_PATH.matcher(path).matches();
    }

    static boolean isLocalMediaRequest(String host, String path) {
        if (host == null || !isValidMediaPath(path)) return false;
        return "localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host);
    }

    static String mimeTypeFor(String path) {
        if (path == null) return "application/octet-stream";
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg")) return "image/jpeg";
        return "application/octet-stream";
    }

    static String buildRemoteUrl(String base, String path) {
        return stripTrailingSlash(base) + path;
    }

    static long[] parseByteRange(String rangeHeader, int totalLength) {
        if (rangeHeader == null || totalLength <= 0) return null;
        String trimmed = rangeHeader.trim();
        if (trimmed.length() <= 6 || !trimmed.regionMatches(true, 0, "bytes=", 0, 6)) return null;
        String spec = trimmed.substring(6).trim();
        if (spec.isEmpty() || spec.indexOf(',') >= 0) return null;
        String[] parts = spec.split("-", -1);
        if (parts.length != 2) return null;
        String startStr = parts[0].trim();
        String endStr = parts[1].trim();
        try {
            long start;
            long end;
            if (startStr.isEmpty()) {
                if (endStr.isEmpty()) return null;
                long suffix = Long.parseLong(endStr);
                if (suffix <= 0) return null;
                start = Math.max(0L, totalLength - suffix);
                end = totalLength - 1L;
            } else {
                start = Long.parseLong(startStr);
                end = endStr.isEmpty() ? totalLength - 1L : Long.parseLong(endStr);
            }
            if (start < 0 || start >= totalLength || end < start) return null;
            if (end >= totalLength) end = totalLength - 1L;
            return new long[] { start, end };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    byte[] loadBytes(String path) throws IOException {
        if (!isValidMediaPath(path)) return null;
        File cached = cacheFileFor(path);
        if (cached != null && cached.isFile() && cached.length() > 0 && cached.length() <= MAX_FILE_BYTES) {
            try {
                return readFile(cached);
            } catch (IOException ignored) {
                // Fall through and re-fetch if cache file became unreadable.
            }
        }
        byte[] fetched = fetcher.fetch(buildRemoteUrl(remoteBase, path));
        if (fetched == null || fetched.length == 0) return null;
        if (fetched.length > MAX_FILE_BYTES) {
            throw new IOException("Media asset exceeds size cap");
        }
        if (cached != null) {
            writeCacheAtomically(cached, fetched);
        }
        return fetched;
    }

    WebResourceResponse serve(String path, String rangeHeader) {
        if (!isValidMediaPath(path)) {
            return emptyResponse(404, "Not Found");
        }
        try {
            byte[] data = loadBytes(path);
            if (data == null) {
                return emptyResponse(404, "Not Found");
            }
            String mime = mimeTypeFor(path);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "public, max-age=2592000, immutable");
            headers.put("Accept-Ranges", "bytes");
            long[] range = parseByteRange(rangeHeader, data.length);
            if (range != null) {
                int start = (int) range[0];
                int end = (int) range[1];
                int len = end - start + 1;
                byte[] slice = Arrays.copyOfRange(data, start, end + 1);
                headers.put("Content-Range", "bytes " + start + "-" + end + "/" + data.length);
                headers.put("Content-Length", String.valueOf(len));
                return new WebResourceResponse(mime, null, 206, "Partial Content", headers, new ByteArrayInputStream(slice));
            }
            headers.put("Content-Length", String.valueOf(data.length));
            return new WebResourceResponse(mime, null, 200, "OK", headers, new ByteArrayInputStream(data));
        } catch (IOException e) {
            return emptyResponse(503, "Service Unavailable");
        }
    }

    private File cacheFileFor(String path) {
        if (cacheRoot == null) return null;
        return new File(cacheRoot, path.substring(1));
    }

    private static void writeCacheAtomically(File target, byte[] data) {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
            return;
        }
        File tmp = new File(parent, target.getName() + "." + Thread.currentThread().getId() + "." + System.nanoTime() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.flush();
        } catch (IOException e) {
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(target)) {
            if (!target.exists() || target.length() == 0) {
                target.delete();
                tmp.renameTo(target);
            }
            if (tmp.exists()) tmp.delete();
        }
    }

    private static byte[] readFile(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            return readStreamBounded(in, MAX_FILE_BYTES);
        }
    }

    private static byte[] httpFetch(String urlString) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlString).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod("GET");
        conn.setRequestProperty("User-Agent", "RitAndroid/1.0");
        try {
            int code = conn.getResponseCode();
            if (code == 404 || code == 410) return null;
            if (code != 200) throw new IOException("HTTP " + code);
            String ct = conn.getContentType();
            if (ct != null && ct.toLowerCase(Locale.ROOT).contains("text/html")) {
                return null;
            }
            try (InputStream in = conn.getInputStream()) {
                return readStreamBounded(in, MAX_FILE_BYTES);
            }
        } finally {
            conn.disconnect();
        }
    }

    private static byte[] readStreamBounded(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int total = 0;
        int n;
        while ((n = in.read(buf)) >= 0) {
            total += n;
            if (total > maxBytes) throw new IOException("Response exceeds size cap");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static WebResourceResponse emptyResponse(int status, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers, new ByteArrayInputStream(new byte[0]));
    }

    private static String stripTrailingSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }
}
