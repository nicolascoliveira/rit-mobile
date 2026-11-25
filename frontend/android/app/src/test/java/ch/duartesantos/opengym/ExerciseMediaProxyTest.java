package ch.duartesantos.opengym;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ExerciseMediaProxyTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void validatesStrictMediaPathsAndLocalHostOnly() {
        assertTrue(ExerciseMediaProxy.isLocalMediaRequest("localhost", "/exercise-media/still/0001.webp"));
        assertTrue(ExerciseMediaProxy.isLocalMediaRequest("localhost", "/exercise-media/clip/0025.mp4"));
        assertTrue(ExerciseMediaProxy.isLocalMediaRequest("127.0.0.1", "/exercise-media/clip/9025.webp"));

        assertFalse(ExerciseMediaProxy.isLocalMediaRequest("app.treinerit.com.br", "/exercise-media/still/0001.webp"));
        assertFalse(ExerciseMediaProxy.isLocalMediaRequest("localhost", "/exercise-media/still/../secret.webp"));
        assertFalse(ExerciseMediaProxy.isLocalMediaRequest("localhost", "/exercise-media/other/0001.webp"));
        assertFalse(ExerciseMediaProxy.isLocalMediaRequest("localhost", "/exercise-media/clip/0001.html"));
        assertFalse(ExerciseMediaProxy.isLocalMediaRequest("localhost", "/api/me"));
        assertFalse(ExerciseMediaProxy.isLocalMediaRequest(null, "/exercise-media/still/0001.webp"));
    }

    @Test
    public void mapsMimeTypesAndRemoteUrls() {
        assertEquals("image/webp", ExerciseMediaProxy.mimeTypeFor("/exercise-media/still/0001.webp"));
        assertEquals("video/mp4", ExerciseMediaProxy.mimeTypeFor("/exercise-media/clip/0001.mp4"));
        assertEquals("image/gif", ExerciseMediaProxy.mimeTypeFor("/exercise-media/clip/0001.gif"));
        assertEquals(
                "https://app.treinerit.com.br/exercise-media/clip/0001.mp4",
                ExerciseMediaProxy.buildRemoteUrl("https://app.treinerit.com.br/", "/exercise-media/clip/0001.mp4")
        );
    }

    @Test
    public void parsesSingleByteRangesSafely() {
        assertArrayEquals(new long[] { 0, 9 }, ExerciseMediaProxy.parseByteRange("bytes=0-9", 100));
        assertArrayEquals(new long[] { 50, 99 }, ExerciseMediaProxy.parseByteRange("bytes=50-", 100));
        assertArrayEquals(new long[] { 90, 99 }, ExerciseMediaProxy.parseByteRange("bytes=-10", 100));
        assertArrayEquals(new long[] { 0, 99 }, ExerciseMediaProxy.parseByteRange("bytes=0-999", 100));
        assertNull(ExerciseMediaProxy.parseByteRange(null, 100));
        assertNull(ExerciseMediaProxy.parseByteRange("bytes=100-120", 100));
        assertNull(ExerciseMediaProxy.parseByteRange("bytes=0-5,10-15", 100));
        assertNull(ExerciseMediaProxy.parseByteRange("items=0-5", 100));
    }

    @Test
    public void cachesFetchedMediaOnDiskAndReusesWithoutRefetching() throws IOException {
        File cacheDir = tmp.newFolder("media-cache");
        AtomicInteger calls = new AtomicInteger(0);
        byte[] payload = new byte[] { 1, 2, 3, 4, 5, 6 };
        ExerciseMediaProxy proxy = new ExerciseMediaProxy(cacheDir, "https://app.treinerit.com.br", url -> {
            calls.incrementAndGet();
            assertEquals("https://app.treinerit.com.br/exercise-media/still/0001.webp", url);
            return payload;
        });

        byte[] first = proxy.loadBytes("/exercise-media/still/0001.webp");
        byte[] second = proxy.loadBytes("/exercise-media/still/0001.webp");
        assertArrayEquals(payload, first);
        assertArrayEquals(payload, second);
        assertEquals(1, calls.get());
        assertTrue(new File(cacheDir, "exercise-media/still/0001.webp").isFile());
    }

    @Test
    public void missingRemoteAssetReturnsNullAndWritesNothing() throws IOException {
        File cacheDir = tmp.newFolder("media-cache-miss");
        ExerciseMediaProxy proxy = new ExerciseMediaProxy(cacheDir, "https://app.treinerit.com.br", url -> null);
        assertNull(proxy.loadBytes("/exercise-media/clip/99999.mp4"));
        assertFalse(new File(cacheDir, "exercise-media/clip/99999.mp4").exists());
    }
}
