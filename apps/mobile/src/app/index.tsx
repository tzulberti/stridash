import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { DashboardScreen } from '@/components/DashboardScreen';
import { LoginScreen } from '@/components/LoginScreen';
import { useTheme } from '@/hooks/use-theme';
import { readTokens, saveTokens, clearTokens } from '@/lib/session';
import type { AuthTokens } from '@/lib/api';

export default function HomeScreen() {
  const theme = useTheme();
  const [tokens, setTokens] = useState<AuthTokens | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    readTokens()
      .then((stored) => {
        if (alive) setTokens(stored);
      })
      .catch(() => {
        if (alive) setTokens(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (tokens === undefined) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <ActivityIndicator color={theme.text} />
        <Text style={{ color: theme.textSecondary }}>Opening Stridash…</Text>
      </View>
    );
  }

  if (!tokens) {
    return (
      <LoginScreen
        onTokens={(next) => {
          setTokens(next);
          void saveTokens(next);
        }}
      />
    );
  }

  return (
    <DashboardScreen
      token={tokens.accessToken}
      onSignOut={() => {
        setTokens(null);
        void clearTokens();
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
});
