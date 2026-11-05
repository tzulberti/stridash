/**
 * Stridash smoke screen (M1): verifies the app boots on all three platforms
 * and can reach the Stridash API. Replaced by the real dashboard in M5.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { HealthResponse } from '@stridash/types';

// Server targeting from env: EXPO_PUBLIC_API_URL=http://192.168.x.x:3000
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function HomeScreen() {
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    let alive = true;
    async function check(): Promise<void> {
      try {
        const res = await fetch(`${API_URL}/api/health`);
        if (!res.ok) throw new Error(String(res.status));
        const body: HealthResponse = await res.json();
        if (!alive) return;
        setVersion(body.version);
        setState('up');
      } catch {
        if (alive) setState('down');
      }
    }
    void check();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Stridash</ThemedText>
      <ThemedText>One dashboard for every stride.</ThemedText>

      <View style={styles.statusRow}>
        {state === 'checking' ? (
          <ActivityIndicator size="small" />
        ) : (
          <ThemedText type="smallBold" style={state === 'up' ? styles.up : styles.down}>
            {state === 'up' ? `● API up (v${version})` : '● API unreachable'}
          </ThemedText>
        )}
      </View>

      <ThemedText type="small" style={styles.hint}>
        Server: {API_URL} — set EXPO_PUBLIC_API_URL to point at yours.
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.one,
  },
  statusRow: {
    minHeight: 28,
    justifyContent: 'center',
    marginTop: Spacing.three,
  },
  up: { color: '#2e7d32' },
  down: { color: '#b02a2a' },
  hint: {
    textAlign: 'center',
    marginTop: Spacing.two,
  },
});
