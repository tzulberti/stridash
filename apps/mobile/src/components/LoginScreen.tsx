import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { login, register, type AuthTokens } from '@/lib/api';

export function LoginScreen(props: { onTokens: (tokens: AuthTokens) => void }) {
  const { onTokens } = props;
  const theme = useTheme();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        const res = await register(email.trim(), password, displayName.trim());
        onTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      } else {
        onTokens(await login(email.trim(), password));
      }
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, { color: theme.text }]}>🦾 Stridash</Text>
          <Text style={[styles.tagline, { color: theme.textSecondary }]}>
            One dashboard for every stride.
          </Text>

          {mode === 'register' && (
            <TextInput
              style={[
                styles.input,
                { color: theme.text, backgroundColor: theme.backgroundElement },
              ]}
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="display name"
              placeholderTextColor={theme.textSecondary}
              autoComplete="name"
              maxLength={80}
            />
          )}
          <TextInput
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
            value={email}
            onChangeText={setEmail}
            placeholder="email"
            placeholderTextColor={theme.textSecondary}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          <TextInput
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
            value={password}
            onChangeText={setPassword}
            placeholder="password"
            placeholderTextColor={theme.textSecondary}
            secureTextEntry
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={() => void submit()}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>
                {mode === 'register' ? 'Create account' : 'Sign in'}
              </Text>
            )}
          </Pressable>
          <Pressable
            style={styles.link}
            onPress={() => {
              setMode(mode === 'register' ? 'login' : 'register');
              setError(null);
            }}
          >
            <Text style={{ color: theme.textSecondary }}>
              {mode === 'register'
                ? 'Already have an account? Sign in'
                : 'Need an account? Create one'}
            </Text>
          </Pressable>
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={styles.spacer} />
          <Text style={{ color: theme.textSecondary, textAlign: 'center' }}>
            Server: {process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.two,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  title: { fontSize: 36, fontWeight: '700', textAlign: 'center' },
  tagline: { fontSize: 16, textAlign: 'center', marginBottom: Spacing.three },
  input: {
    borderRadius: 10,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    minHeight: 48,
  },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 10,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { paddingVertical: Spacing.two, alignItems: 'center' },
  error: { color: '#b02a2a', textAlign: 'center' },
  spacer: { height: Spacing.three },
});
