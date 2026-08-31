import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { classifyImage } from '../services/imageClassifier';
import { initModel } from '../services/nsfwClassifier';
import { getLastCapturePath } from '../utils/lastCapturePath';
import { scLog } from '../utils/screenCaptureLogger';
import { toMlKitImageUri } from '../utils/imageUri';
import { Button, Card, SectionLabel } from './ui';
import { colors, spacing } from '../theme';

/**
 * Debug panel: classify the latest screen-capture JPEG via TFLite NSFW.
 * Enable with EXPO_PUBLIC_NSFW_DEBUG=1 or __DEV__ (see App.tsx).
 */
export function NsfwDebugPanel() {
  const [status, setStatus] = useState<string>('Idle');
  const [loading, setLoading] = useState(false);

  const runTest = useCallback(async () => {
    if (Platform.OS !== 'android') {
      setStatus('Android only');
      return;
    }
    setLoading(true);
    setStatus('Loading model…');
    try {
      await initModel();
      const filePath = getLastCapturePath();
      if (!filePath) {
        setStatus('No capture yet — enable monitoring and wait for a screenshot.');
        setLoading(false);
        return;
      }
      const uri = toMlKitImageUri(filePath);
      setStatus(`Classifying ${filePath.slice(-48)}…`);
      const result = await classifyImage(uri, filePath);
      const details = result.imageClassificationDetails;
      const line = [
        `source=${details?.source}`,
        `nsfw=${details?.nsfwSource}`,
        `risk=${details?.imageRiskScore}`,
        `adult=${(details?.adultScore ?? 0).toFixed(2)}`,
        `tflite=[${(details?.tfliteOutputs ?? []).map((n) => n.toFixed(2)).join(', ')}]`,
      ].join(' ');
      scLog('[NSFW Debug]', result as unknown as Record<string, unknown>);
      setStatus(line);
    } catch (err) {
      setStatus(`Error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <View style={{ gap: spacing.md }}>
      <SectionLabel>Developer · NSFW TFLite</SectionLabel>
      <Card>
        <Button
          label="Classify last capture"
          busyLabel="Classifying…"
          loading={loading}
          variant="secondary"
          onPress={runTest}
        />
        <View style={styles.statusBox}>
          <Text style={styles.status}>{status}</Text>
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  statusBox: {
    marginTop: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    padding: spacing.md,
  },
  status: { fontFamily: 'monospace', fontSize: 12, color: colors.textMuted, lineHeight: 18 },
});
