package ch.duartesantos.opengym;

import static org.junit.Assert.*;

import org.junit.Test;

public class RitInboxTest {
    @Test
    public void buildsPendingUrlCleanly() {
        assertEquals(
                "https://app.treinerit.duckdns.org/api/notifications/pending?since=42&limit=20",
                RitInbox.buildPendingUrl("https://app.treinerit.duckdns.org/", 42L, 20)
        );
        assertEquals(
                "https://app.treinerit.duckdns.org/api/notifications/pending?since=0&limit=50",
                RitInbox.buildPendingUrl("https://app.treinerit.duckdns.org", -5L, 999)
        );
    }

    @Test
    public void parsesAndDeduplicatesPendingNotificationsMonotonically() {
        String raw = "{\"ok\":true,\"latestId\":15,\"notifications\":["
                + "{\"id\":10,\"title\":\"Old\",\"body\":\"Ignored\",\"tag\":\"test\",\"url\":\"#/\"},"
                + "{\"id\":12,\"title\":\"Nova ficha liberada!\",\"body\":\"Prof. Ana atualizou seu treino\",\"tag\":\"prescription-update\",\"url\":\"#/\"},"
                + "{\"id\":15,\"title\":\"Resumo da semana\",\"body\":\"4/4 treinos\",\"tag\":\"weekly-summary\",\"url\":\"#/\"}"
                + "]}";
        RitInbox.ParsedBatch batch = RitInbox.parsePendingResponse(raw, 10L);
        assertEquals(15L, batch.nextLastId);
        assertEquals(2, batch.items.size());
        assertEquals(12L, batch.items.get(0).id);
        assertEquals("Nova ficha liberada!", batch.items.get(0).title);
        assertEquals("prescription-update", batch.items.get(0).tag);
        assertEquals(15L, batch.items.get(1).id);
        assertEquals("weekly-summary", batch.items.get(1).tag);
    }

    @Test
    public void ignoresInvalidJsonAndKeepsNotificationIdsWithinDedicatedRange() {
        RitInbox.ParsedBatch bad = RitInbox.parsePendingResponse("<html>error</html>", 9L);
        assertEquals(9L, bad.nextLastId);
        assertTrue(bad.items.isEmpty());

        int id1 = RitInbox.notificationIdFor(1L);
        int id2 = RitInbox.notificationIdFor(123456L);
        assertTrue(id1 >= 47000 && id1 < 48000);
        assertTrue(id2 >= 47000 && id2 < 48000);
    }
}
