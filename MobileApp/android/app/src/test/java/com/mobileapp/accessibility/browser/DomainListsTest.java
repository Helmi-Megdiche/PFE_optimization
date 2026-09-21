package com.mobileapp.accessibility.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class DomainListsTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private final NeverBlockList neverBlock =
            new NeverBlockList(
                    Arrays.asList(
                            "google.*", "bing.com", "youtube.com", "reddit.com", "wikipedia.org"));

    private static ByteArrayInputStream asset(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
    }

    private DomainLists newLists(File file) {
        return new DomainLists(neverBlock, file, Runnable::run, msg -> {});
    }

    private static List<String> lines(File f) throws IOException {
        if (!f.exists()) {
            return Collections.emptyList();
        }
        List<String> out = new ArrayList<>();
        for (String l : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
            if (!l.trim().isEmpty()) {
                out.add(l.trim());
            }
        }
        return out;
    }

    // ---- loading ----------------------------------------------------------------------------

    @Test
    public void beforeLoadNothingMatchesAndItIsReported() {
        DomainLists lists = newLists(new File(tmp.getRoot(), "dyn.txt"));
        assertFalse(lists.isLoaded());
        assertNull(lists.match("pornhub.com"));
    }

    @Test
    public void addBeforeLoadIsRefusedAndNeverTouchesTheFile() throws IOException {
        File f = tmp.newFile("dyn.txt");
        Files.write(f.toPath(), "kept-site.com\n".getBytes(StandardCharsets.UTF_8));
        DomainLists lists = newLists(f);
        assertEquals(DomainLists.AddResult.NOT_LOADED, lists.addDetected("new-site.com"));
        lists.replaceDynamic(Collections.singletonList("other.com"));
        // A partial snapshot written before load would have erased kept-site.com.
        assertEquals(Collections.singletonList("kept-site.com"), lines(f));
    }

    @Test
    public void loadSkipsCommentsAndBlanksAndDedupes() throws IOException {
        DomainLists lists = newLists(new File(tmp.getRoot(), "dyn.txt"));
        lists.load(asset("# header\n\nA.example.com\na.example.com\nb.example.com\n# c\n"));
        assertTrue(lists.isLoaded());
        assertEquals(2, lists.staticSize());
        assertNotNull(lists.match("a.example.com"));
    }

    @Test
    public void loadReadsAndDedupesTheDynamicFile() throws IOException {
        File f = tmp.newFile("dyn.txt");
        Files.write(f.toPath(), "site.com\nsite.com\nOther.net\n".getBytes(StandardCharsets.UTF_8));
        DomainLists lists = newLists(f);
        lists.load(asset(""));
        assertEquals(new HashSet<>(Arrays.asList("site.com", "other.net")), lists.dynamicSnapshot());
        assertEquals(DomainMatcher.ListSource.DETECTED, lists.match("www.site.com").source);
    }

    // ---- adding a detected domain -------------------------------------------------------------

    @Test
    public void addStoresTheRegistrableDomainAndMatchesItsSubdomains() throws IOException {
        DomainLists lists = newLists(new File(tmp.getRoot(), "dyn.txt"));
        lists.load(asset(""));
        assertEquals(DomainLists.AddResult.ADDED, lists.addDetected("www.pornhub.com"));
        assertEquals(Collections.singleton("pornhub.com"), lists.dynamicSnapshot());
        assertNotNull(lists.match("pornhub.com"));
        assertNotNull(lists.match("m.pornhub.com"));
    }

    @Test
    public void addRefusesNeverBlockDomains() throws IOException {
        File f = new File(tmp.getRoot(), "dyn.txt");
        DomainLists lists = newLists(f);
        lists.load(asset(""));
        for (String host :
                new String[] {
                    "google.com", "www.google.fr", "google.co.uk", "en.wikipedia.org",
                    "reddit.com", "www.youtube.com", "bing.com"
                }) {
            assertEquals(host, DomainLists.AddResult.REFUSED_NEVER_BLOCK, lists.addDetected(host));
        }
        assertTrue(lists.dynamicSnapshot().isEmpty());
        assertTrue(lines(f).isEmpty());
    }

    @Test
    public void addingASecondTimeIsADuplicate() throws IOException {
        File f = new File(tmp.getRoot(), "dyn.txt");
        DomainLists lists = newLists(f);
        lists.load(asset(""));
        assertEquals(DomainLists.AddResult.ADDED, lists.addDetected("xhamster.com"));
        assertEquals(DomainLists.AddResult.DUPLICATE, lists.addDetected("www.xhamster.com"));
        assertEquals(Collections.singletonList("xhamster.com"), lines(f));
    }

    @Test
    public void addRefusesInvalidHosts() throws IOException {
        DomainLists lists = newLists(new File(tmp.getRoot(), "dyn.txt"));
        lists.load(asset(""));
        assertEquals(DomainLists.AddResult.REFUSED_INVALID, lists.addDetected(null));
        assertEquals(DomainLists.AddResult.REFUSED_INVALID, lists.addDetected("localhost"));
        assertEquals(DomainLists.AddResult.REFUSED_INVALID, lists.addDetected("co.uk"));
        assertEquals(DomainLists.AddResult.REFUSED_INVALID, lists.addDetected("127.0.0.1"));
        assertEquals(DomainLists.AddResult.REFUSED_INVALID, lists.addDetected("example.com net"));
        assertTrue(lists.dynamicSnapshot().isEmpty());
    }

    @Test
    public void addedDomainsSurviveARestart() throws IOException {
        File f = new File(tmp.getRoot(), "dyn.txt");
        DomainLists first = newLists(f);
        first.load(asset(""));
        first.addDetected("pornhub.com");

        DomainLists second = newLists(f);
        second.load(asset(""));
        assertNotNull(second.match("pornhub.com"));
    }

    @Test
    public void staticAndDetectedAreReportedSeparately() throws IOException {
        DomainLists lists = newLists(new File(tmp.getRoot(), "dyn.txt"));
        lists.load(asset("static-site.com\n"));
        lists.addDetected("dyn-site.com");
        assertEquals(DomainMatcher.ListSource.STATIC, lists.match("static-site.com").source);
        assertEquals(DomainMatcher.ListSource.DETECTED, lists.match("dyn-site.com").source);
    }

    // ---- syncing from the server ----------------------------------------------------------------

    @Test
    public void replaceDynamicDropsRowsTheParentRemoved() throws IOException {
        File f = new File(tmp.getRoot(), "dyn.txt");
        DomainLists lists = newLists(f);
        lists.load(asset(""));
        lists.addDetected("a-site.com");
        lists.addDetected("b-site.com");

        lists.replaceDynamic(Arrays.asList("b-site.com", "c-site.com"));

        assertNull(lists.match("a-site.com"));
        assertNotNull(lists.match("b-site.com"));
        assertNotNull(lists.match("c-site.com"));
        assertEquals(Arrays.asList("b-site.com", "c-site.com"), lines(f));
    }

    @Test
    public void replaceDynamicNeverIntroducesANeverBlockDomain() throws IOException {
        DomainLists lists = newLists(new File(tmp.getRoot(), "dyn.txt"));
        lists.load(asset(""));
        lists.replaceDynamic(Arrays.asList("google.com", "ok-site.com", "not a host"));
        assertEquals(Collections.singleton("ok-site.com"), lists.dynamicSnapshot());
    }

    // ---- thread safety (B1) -----------------------------------------------------------------------

    private static void await(CountDownLatch latch) throws InterruptedException {
        assertTrue("workers did not finish", latch.await(30, TimeUnit.SECONDS));
    }

    @Test
    public void concurrentAddsAndMatchesLoseNothing() throws Exception {
        File f = new File(tmp.getRoot(), "dyn.txt");
        ExecutorService writer = Executors.newSingleThreadExecutor();
        DomainLists lists = new DomainLists(neverBlock, f, writer, msg -> {});
        lists.load(asset("static-site.com\n"));

        final int threads = 8;
        final int perThread = 25;
        final List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch done = new CountDownLatch(threads + 2);
        final java.util.concurrent.atomic.AtomicBoolean stop =
                new java.util.concurrent.atomic.AtomicBoolean(false);
        final java.util.concurrent.atomic.AtomicInteger added =
                new java.util.concurrent.atomic.AtomicInteger();

        for (int r = 0; r < 2; r++) {
            new Thread(
                            () -> {
                                try {
                                    while (!stop.get()) {
                                        lists.match("static-site.com");
                                        lists.match("x.site-0-0.com");
                                        lists.dynamicSnapshot();
                                    }
                                } catch (Throwable t) {
                                    errors.add(t);
                                } finally {
                                    done.countDown();
                                }
                            })
                    .start();
        }
        final CountDownLatch writersDone = new CountDownLatch(threads);
        for (int t = 0; t < threads; t++) {
            final int tt = t;
            new Thread(
                            () -> {
                                try {
                                    for (int i = 0; i < perThread; i++) {
                                        if (lists.addDetected("site-" + tt + "-" + i + ".com")
                                                == DomainLists.AddResult.ADDED) {
                                            added.incrementAndGet();
                                        }
                                    }
                                } catch (Throwable e) {
                                    errors.add(e);
                                } finally {
                                    writersDone.countDown();
                                    done.countDown();
                                }
                            })
                    .start();
        }
        await(writersDone);
        stop.set(true);
        await(done);
        writer.shutdown();
        assertTrue(writer.awaitTermination(30, TimeUnit.SECONDS));

        assertTrue("worker errors: " + errors, errors.isEmpty());
        assertEquals(threads * perThread, added.get());
        assertEquals(threads * perThread, lists.dynamicSnapshot().size());
        assertEquals(lists.dynamicSnapshot(), new HashSet<>(lines(f)));
    }

    @Test
    public void concurrentAddsAndSyncsLeaveTheFileEqualToMemory() throws Exception {
        File f = new File(tmp.getRoot(), "dyn.txt");
        ExecutorService writer = Executors.newSingleThreadExecutor();
        DomainLists lists = new DomainLists(neverBlock, f, writer, msg -> {});
        lists.load(asset(""));

        final List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());
        final int workers = 10;
        final CountDownLatch done = new CountDownLatch(workers);
        for (int t = 0; t < workers; t++) {
            final int tt = t;
            new Thread(
                            () -> {
                                try {
                                    for (int i = 0; i < 30; i++) {
                                        if (tt % 3 == 0) {
                                            lists.replaceDynamic(
                                                    Arrays.asList(
                                                            "sync-" + tt + "-" + i + ".com",
                                                            "sync-shared.com"));
                                        } else if (tt % 3 == 1) {
                                            lists.addDetected("add-" + tt + "-" + i + ".com");
                                        } else {
                                            lists.match("www.sync-shared.com");
                                            lists.match("add-1-1.com");
                                        }
                                    }
                                } catch (Throwable e) {
                                    errors.add(e);
                                } finally {
                                    done.countDown();
                                }
                            })
                    .start();
        }
        await(done);
        writer.shutdown();
        assertTrue(writer.awaitTermination(30, TimeUnit.SECONDS));

        assertTrue("worker errors: " + errors, errors.isEmpty());
        // Whatever order the operations interleaved in, the persisted file must describe exactly
        // the final in-memory set (writes are ordered snapshots, never lost or reordered).
        assertEquals(lists.dynamicSnapshot(), new HashSet<>(lines(f)));
    }
}
