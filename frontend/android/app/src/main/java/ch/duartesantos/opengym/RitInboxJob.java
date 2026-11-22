package ch.duartesantos.opengym;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;

/**
 * Periodic JobScheduler worker that checks GET /api/notifications/pending in the background
 * and posts native Android notifications for trainer updates, frequency recaps, and alerts.
 */
public class RitInboxJob extends JobService {
    private volatile Thread worker;

    @Override
    public boolean onStartJob(JobParameters params) {
        final Context ctx = getApplicationContext();
        worker = new Thread(() -> {
            try {
                RitInbox.pollNow(ctx);
            } catch (Exception ignored) {
                // Offline or transient server error: try again on the next scheduled tick.
            }
            jobFinished(params, false);
        }, "rit-inbox-poll");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Thread t = worker;
        if (t != null) t.interrupt();
        return false;
    }
}
