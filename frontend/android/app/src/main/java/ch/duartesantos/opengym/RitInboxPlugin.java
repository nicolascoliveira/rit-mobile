package ch.duartesantos.opengym;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Bridges frontend/src/lib/mobile-inbox.js to RitInbox + RitInboxJob.
 */
@CapacitorPlugin(name = "RitInbox")
public class RitInboxPlugin extends Plugin {

    @PluginMethod
    public void arm(PluginCall call) {
        String server = call.getString("server", "");
        String userId = call.getString("userId", "");
        if (server == null || server.isEmpty()) {
            call.reject("server is required");
            return;
        }
        try {
            JSObject headers = call.getObject("headers", new JSObject());
            long lastId = RitInbox.arm(getContext(), server, headers, userId == null ? "" : userId);
            JSObject out = new JSObject();
            out.put("lastId", lastId);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("could not arm inbox", e);
        }
    }

    @PluginMethod
    public void poll(PluginCall call) {
        final android.content.Context ctx = getContext().getApplicationContext();
        new Thread(() -> {
            try {
                JSONObject res = RitInbox.pollNow(ctx);
                if (res == null) {
                    JSObject empty = new JSObject();
                    empty.put("ok", false);
                    empty.put("notifications", new JSONArray());
                    call.resolve(empty);
                    return;
                }
                call.resolve(JSObject.fromJSONObject(res));
            } catch (Exception e) {
                JSObject empty = new JSObject();
                empty.put("ok", false);
                empty.put("notifications", new JSONArray());
                call.resolve(empty);
            }
        }, "rit-inbox-fg").start();
    }

    @PluginMethod
    public void disarm(PluginCall call) {
        RitInbox.clear(getContext());
        call.resolve();
    }
}
