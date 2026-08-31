package com.mobileapp.screencapture;

import java.nio.ByteBuffer;

/**
 * Stateless perceptual difference-hash (dHash) utility for the screen-capture pipeline.
 *
 * <p>Used to decide, entirely in native memory, whether a freshly acquired frame is
 * visually distinct enough from the last processed frame to be worth OCR / NSFW / a
 * screen event. The hash is a 64-bit integer that never leaves the device — it is never
 * written to a file, logged as image data, or sent to the backend.
 *
 * <p>Reads sample the {@link ByteBuffer} with absolute {@code get(int)} calls only, so the
 * buffer position is left untouched for the subsequent {@code copyPixelsFromBuffer} in
 * {@code ScreenCaptureModule.saveImageToJpeg}. No Bitmap, no full-buffer copy.
 */
final class FrameHasher {

    private FrameHasher() {}

    /**
     * Samples a 9x8 grid of points, converts each RGBA sample to luminance, then for each
     * of the 8 rows compares the 8 adjacent horizontal pairs (bit set when left > right).
     *
     * @param buffer      plane 0 buffer (RGBA_8888)
     * @param rowStride   plane 0 row stride in bytes
     * @param pixelStride plane 0 pixel stride in bytes
     * @param width       frame width in pixels (use {@code Image.getWidth()})
     * @param height      frame height in pixels (use {@code Image.getHeight()})
     * @return the 64-bit dHash
     */
    static long computeDHash(ByteBuffer buffer, int rowStride, int pixelStride,
                             int width, int height) {
        long hash = 0L;
        int limit = buffer.limit();
        for (int row = 0; row < 8; row++) {
            int y = (int) ((long) row * (height - 1) / 7);
            int prevLum = -1;
            for (int col = 0; col < 9; col++) {
                int x = (int) ((long) col * (width - 1) / 8);
                int off = y * rowStride + x * pixelStride;
                int lum;
                if (off >= 0 && off + 2 < limit) {
                    int r = buffer.get(off) & 0xFF;
                    int g = buffer.get(off + 1) & 0xFF;
                    int b = buffer.get(off + 2) & 0xFF;
                    lum = (299 * r + 587 * g + 114 * b) / 1000;
                } else {
                    lum = 0;
                }
                if (col > 0) {
                    hash = (hash << 1) | (prevLum > lum ? 1L : 0L);
                }
                prevLum = lum;
            }
        }
        return hash;
    }

    /** Number of differing bits between two hashes. */
    static int hammingDistance(long a, long b) {
        return Long.bitCount(a ^ b);
    }
}
