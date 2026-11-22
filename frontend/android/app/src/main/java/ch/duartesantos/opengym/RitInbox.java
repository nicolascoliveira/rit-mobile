package ch.duartesantos.opengym;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native Android notification inbox for server-side Rit events (updated workout plans,
 * weekly frequency recaps, assessments, video feedback, reminders).
 *
 * Works without Firebase Cloud Messaging: stores the paired server + Bearer headers encrypted via
 * Android Keystore (NudgeCheck.seal/open), polls GET /api/notifications/pending both from the
 * foreground plugin and a persisted JobScheduler periodic worker, and posts native high-priority
 * notifications with deduplication via monotonic lastId.
 */
final class RitInbox {
    static final int JOB_ID = 46_202;
    static final int NOTIF_ID_BASE = 47_000;
    static final String CHANNEL_ID = "rit_updates";
    static final String CHANNEL_NAME = "Atualizações do Rit";
    private static final String PREFS = "rit_mobile_inbox";
    private static final long PERIOD_MS = 15 * 60_000L;
    private static final int MAX_RESPONSE_BYTES = 128 * 1024;
    private static final Object POLL_LOCK = new Object();

    static final class Item {
        final long id;
        final String title;
        final String body;
        final String tag;
        final String url;

        Item(long id, String title, String body, String tag, String url) {
            this.id = id;
            this.title = title;
            this.body = body;
            this.tag = tag;
            this.url = url;
        }
    }

    static final class ParsedBatch {
        final long nextLastId;
        final List<Item> items;

        ParsedBatch(long nextLastId, List<Item> items) {
            this.nextLastId = nextLastId;
            this.items = items;
        }
    }

    private RitInbox() {}

    static int notificationIdFor(long serverId) {
        return NOTIF_ID_BASE + (int) (Math.abs(serverId) % 1000L);
    }

    static String buildPendingUrl(String server, long sinceId, int limit) {
        String base = server == null ? "" : server.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        long safeSince = Math.max(0L, sinceId);
        int safeLimit = Math.max(1, Math.min(50, limit));
        return base + "/api/notifications/pending?since=" + safeSince + "&limit=" + safeLimit;
    }

    static ParsedBatch parsePendingResponse(String rawJson, long prevLastId) {
        List<Item> out = new ArrayList<>();
        long nextId = Math.max(0L, prevLastId);
        if (rawJson == null || rawJson.trim().isEmpty()) {
            return new ParsedBatch(nextId, out);
        }
        try {
            JSONObject obj = new JSONObject(rawJson);
            long latest = obj.optLong("latestId", 0L);
            if (latest > nextId) nextId = latest;
            JSONArray arr = obj.optJSONArray("notifications");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject row = arr.optJSONObject(i);
                    if (row == null) continue;
                    long id = row.optLong("id", 0L);
                    String title = row.optString("title", "").trim();
                    if (id <= prevLastId || title.isEmpty()) continue;
                    String body = row.optString("body", "").trim();
                    String tag = row.optString("tag", "").trim();
                    String url = row.optString("url", "#/").trim();
                    out.add(new Item(id, title, body, tag, url.isEmpty() ? "#/" : url));
                    if (id > nextId) nextId = id;
                }
            }
        } catch (Exception ignored) {
            // Malformed response: advance nothing and emit nothing.
        }
        return new ParsedBatch(nextId, out);
    }

    static boolean save(Context ctx, JSONObject config) {
        String[] sealed = NudgeCheck.seal(config.toString());
        if (sealed == null) return false;
        prefs(ctx).edit().putString("iv", sealed[0]).putString("config", sealed[1]).apply();
        return true;
    }

    static JSONObject load(Context ctx) {
        SharedPreferences p = prefs(ctx);
        String plain = NudgeCheck.open(p.getString("iv", null), p.getString("config", null));
        try {
            return plain == null ? null : new JSONObject(plain);
        } catch (Exception e) {
            return null;
        }
    }

    static long arm(Context ctx, String server, JSONObject headers, String userId) throws Exception {
        synchronized (POLL_LOCK) {
            JSONObject prev = load(ctx);
            long lastId = 0L;
            if (prev != null
                    && server.equals(prev.optString("server", ""))
                    && userId.equals(prev.optString("userId", ""))) {
                lastId = Math.max(0L, prev.optLong("lastId", 0L));
            }
            JSONObject cfg = new JSONObject()
                    .put("server", server)
                    .put("userId", userId)
                    .put("headers", headers != null ? headers : new JSONObject())
                    .put("lastId", lastId);
            if (!save(ctx, cfg)) {
                throw new IllegalStateException("could not persist inbox config");
            }
            schedule(ctx);
            return lastId;
        }
    }

    static void clear(Context ctx) {
        synchronized (POLL_LOCK) {
            prefs(ctx).edit().clear().apply();
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) js.cancel(JOB_ID);
        }
    }

    static void schedule(Context ctx) {
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        JobInfo existing = js.getPendingJob(JOB_ID);
        if (existing != null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, RitInboxJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD_MS)
                .setPersisted(true)
                .build();
        js.schedule(job);
    }

    static JSONObject pollNow(Context ctx) {
        synchronized (POLL_LOCK) {
            JSONObject cfg = load(ctx);
            if (cfg == null) return null;
            String server = cfg.optString("server", "");
            if (server.isEmpty()) return null;
            JSONObject headers = cfg.optJSONObject("headers");
            long prevLastId = Math.max(0L, cfg.optLong("lastId", 0L));
            String raw = fetchPendingJson(server, prevLastId, headers);
            if (raw == null) return null;

            ParsedBatch batch = parsePendingResponse(raw, prevLastId);
            JSONArray delivered = new JSONArray();
            for (Item item : batch.items) {
                postNotification(ctx, item.id, item.title, item.body);
                try {
                    delivered.put(new JSONObject()
                            .put("id", item.id)
                            .put("title", item.title)
                            .put("body", item.body)
                            .put("tag", item.tag)
                            .put("url", item.url));
                } catch (Exception ignored) { /* skip malformed item */ }
            }
            if (batch.nextLastId > prevLastId) {
                try {
                    cfg.put("lastId", batch.nextLastId);
                    save(ctx, cfg);
                } catch (Exception ignored) { /* retry on next poll */ }
            }
            try {
                return new JSONObject()
                        .put("ok", true)
                        .put("latestId", batch.nextLastId)
                        .put("notifications", delivered);
            } catch (Exception e) {
                return null;
            }
        }
    }

    static boolean postNotification(Context ctx, long id, String title, String body) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !nm.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
            ch.enableVibration(true);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        int notifId = notificationIdFor(id);
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(
                ctx,
                notifId,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(ctx, CHANNEL_ID)
                : new Notification.Builder(ctx);
        b.setSmallIcon(R.drawable.ic_stat_dumbbell)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(tap);
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_HIGH);
            b.setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            nm.notify(notifId, b.build());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String fetchPendingJson(String server, long sinceId, JSONObject headers) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(buildPendingUrl(server, sinceId, 20));
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(10_000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    conn.setRequestProperty(k, headers.optString(k));
                }
            }
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < MAX_RESPONSE_BYTES) {
                    out.write(buf, 0, n);
                }
                return out.toString(StandardCharsets.UTF_8.name());
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
