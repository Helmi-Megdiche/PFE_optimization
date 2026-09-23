package com.mobileapp.accessibility.browser;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

/**
 * The static (pre-loaded) and dynamic (detected) domain lists.
 *
 * <p><b>Threading (B1).</b> Three threads touch this: the accessibility main thread matches, the
 * RN NativeModules thread adds and syncs, and a background thread loads. Readers are lock-free:
 * each list is an <i>immutable</i> set behind a {@code volatile} reference that is replaced
 * wholesale (copy-on-write; adds are rare). Writers serialize on one lock. Every change enqueues a
 * full snapshot write on the single-thread {@code writer} <i>while holding that lock</i>, so
 * snapshots reach the file in the same order as the in-memory changes and the file always ends up
 * equal to memory.
 *
 * <p>The dynamic file lives in {@code filesDir}, never {@code cacheDir} (the OS or the user can
 * wipe the cache). One host per line, deduped on load. Only registrable domains are stored, never
 * paths or URLs.
 *
 * <p>Pure Java, no {@code android.*} imports.
 */
public final class DomainLists {

    public enum AddResult {
        ADDED,
        DUPLICATE,
        REFUSED_NEVER_BLOCK,
        REFUSED_INVALID,
        NOT_LOADED
    }

    public interface Logger {
        void log(String message);
    }

    private final NeverBlockList neverBlock;
    private final File dynamicFile;
    private final Executor writer;
    private final Logger logger;
    private final Object lock = new Object();

    private volatile Set<String> staticSet = Collections.emptySet();
    private volatile Set<String> dynamicSet = Collections.emptySet();
    private volatile boolean loaded;
    /** Debug-only switch (see {@link DevStaticSwitch}); always true in a release build. */
    private volatile boolean staticEnabled = true;

    public DomainLists(
            NeverBlockList neverBlock, File dynamicFile, Executor writer, Logger logger) {
        this.neverBlock = neverBlock;
        this.dynamicFile = dynamicFile;
        this.writer = writer;
        this.logger = logger;
    }

    // ---- loading ---------------------------------------------------------------------------

    /** Loads the static asset and the dynamic file, then publishes both. Call off the main thread. */
    public void load(InputStream staticAsset) throws IOException {
        Set<String> stat = readStaticList(staticAsset);
        Set<String> dyn = new HashSet<>();
        if (dynamicFile.exists()) {
            try (InputStream in = new FileInputStream(dynamicFile)) {
                dyn = readList(in, true);
            }
        }
        synchronized (lock) {
            staticSet = Collections.unmodifiableSet(stat);
            dynamicSet = Collections.unmodifiableSet(dyn);
            loaded = true;
        }
    }

    /**
     * The ~77k-entry static list is kept as hashes only ({@link HashedDomainSet}): a String set
     * cost ~6.7 MB and 470-560 ms to build on the test device (R6).
     */
    private static Set<String> readStaticList(InputStream in) throws IOException {
        return HashedDomainSet.fromLines(in);
    }

    private static Set<String> readList(InputStream in, boolean validate) throws IOException {
        Set<String> out = new HashSet<>();
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        String line;
        while ((line = r.readLine()) != null) {
            line = line.trim().toLowerCase(Locale.ROOT);
            if (line.isEmpty() || line.charAt(0) == '#') {
                continue;
            }
            if (validate && HostNormalizer.toHost(line) == null) {
                continue;
            }
            out.add(line);
        }
        return out;
    }

    public void setStaticEnabled(boolean enabled) {
        staticEnabled = enabled;
    }

    public boolean isLoaded() {
        return loaded;
    }

    public int staticSize() {
        return staticSet.size();
    }

    public Set<String> dynamicSnapshot() {
        return dynamicSet;
    }

    // ---- matching --------------------------------------------------------------------------

    /** Null when nothing matches, or when the lists are not loaded yet (fail open, callers log it). */
    public DomainMatcher.Match match(String host) {
        if (!loaded) {
            return null;
        }
        return DomainMatcher.match(
                host, staticEnabled ? staticSet : Collections.<String>emptySet(), dynamicSet);
    }

    // ---- changes ---------------------------------------------------------------------------

    /**
     * Adds the registrable domain of {@code host} to the dynamic list. Refuses never-block
     * domains, which always win over dynamic adds.
     */
    public AddResult addDetected(String host) {
        String h = HostNormalizer.toHost(host);
        String reg = h == null ? null : DomainMatcher.registrable(h);
        if (h == null || reg == null) {
            return AddResult.REFUSED_INVALID;
        }
        if (neverBlock.covers(h) || neverBlock.covers(reg) || neverBlock.isSharedSuffix(h)) {
            return AddResult.REFUSED_NEVER_BLOCK;
        }
        // Shared hosting (blogspot, github.io, ...): every subdomain is someone else's site, so
        // store the exact host. Storing the platform would block every blog on it.
        if (neverBlock.isSharedHost(h)) {
            reg = h;
        }
        synchronized (lock) {
            if (!loaded) {
                return AddResult.NOT_LOADED; // would overwrite the file with a partial snapshot
            }
            if (dynamicSet.contains(reg)) {
                return AddResult.DUPLICATE;
            }
            Set<String> next = new HashSet<>(dynamicSet);
            next.add(reg);
            publishDynamic(next);
            return AddResult.ADDED;
        }
    }

    /**
     * Replaces the dynamic list with the server's (parent removals take effect here). Entries
     * that are invalid or never-block are dropped, so a bad server row cannot block Google.
     */
    public void replaceDynamic(Collection<String> hosts) {
        Set<String> next = new HashSet<>();
        for (String raw : hosts) {
            String h = HostNormalizer.toHost(raw);
            if (h == null
                    || DomainMatcher.registrable(h) == null
                    || neverBlock.covers(h)
                    || neverBlock.isSharedSuffix(h)) {
                continue;
            }
            next.add(h);
        }
        synchronized (lock) {
            if (!loaded) {
                return;
            }
            publishDynamic(next);
        }
    }

    /** Caller holds {@code lock}. */
    private void publishDynamic(Set<String> next) {
        dynamicSet = Collections.unmodifiableSet(next);
        final Set<String> snapshot = new TreeSet<>(next);
        try {
            writer.execute(() -> writeSnapshot(snapshot));
        } catch (RejectedExecutionException e) {
            logger.log("dynamic blacklist write rejected: " + e.getMessage());
        }
    }

    private void writeSnapshot(Set<String> snapshot) {
        File tmp = new File(dynamicFile.getPath() + ".tmp");
        try {
            try (Writer w =
                    new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
                for (String d : snapshot) {
                    w.write(d);
                    w.write('\n');
                }
            }
            if (!tmp.renameTo(dynamicFile)) {
                // Windows (JVM tests) will not rename over an existing file; Android will.
                dynamicFile.delete();
                if (!tmp.renameTo(dynamicFile)) {
                    logger.log("dynamic blacklist rename failed");
                }
            }
        } catch (IOException e) {
            logger.log("dynamic blacklist write failed: " + e.getMessage());
        }
    }
}
