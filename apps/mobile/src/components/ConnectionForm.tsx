import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  connectProvider,
  stravaAuthorizeUrl,
  verifyConnectionMfa,
  type ConnectProviderBody,
} from '@/lib/api';

type Provider = 'omron' | 'igpsport' | 'garmin' | 'zwift' | 'strava';

const LABELS: Record<Provider, string> = {
  omron: 'Omron',
  igpsport: 'iGPSPORT',
  garmin: 'Garmin',
  zwift: 'Zwift',
  strava: 'Strava',
};

/** Mobile provider onboarding: credential forms for Omron/iGPSPORT/Garmin/
 * Zwift plus Strava in the system browser. Garmin 202/MFA continues inline. */
export function ConnectionForm(props: { token: string; onConnected: () => void }) {
  const { token, onConnected } = props;
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>('omron');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState('AR');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mfaId, setMfaId] = useState<string | null>(null);
  const [mfaMethod, setMfaMethod] = useState('code');
  const [mfaCode, setMfaCode] = useState('');

  function pick(p: Provider): void {
    setProvider(p);
    setIdentifier('');
    setPassword('');
    setMsg(null);
    setError(null);
    setMfaId(null);
    setMfaCode('');
  }

  async function connect(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      if (provider === 'strava') {
        const { url } = await stravaAuthorizeUrl(token);
        await WebBrowser.openBrowserAsync(url);
        setMsg('Finish the Strava consent in the browser, then pull to refresh.');
        return;
      }
      const body: ConnectProviderBody =
        provider === 'omron'
          ? {
              provider: 'OMRON',
              identifier: identifier.trim(),
              password,
              country: country.trim().toUpperCase(),
            }
          : provider === 'igpsport'
            ? {
                provider: 'IGPSPORT',
                username: identifier.trim(),
                password,
                region: 'intl',
              }
            : provider === 'garmin'
              ? { provider: 'GARMIN', email: identifier.trim(), password }
              : { provider: 'ZWIFT', username: identifier.trim(), password };
      const result = await connectProvider(token, body);
      if (result.mfaRequired) {
        setMfaId(result.connection?.id ?? null);
        setMfaMethod(result.method ?? 'code');
        setMsg('Garmin needs a second-factor code.');
        return;
      }
      setMsg(`${LABELS[provider]} connected — pull to refresh and sync.`);
      setIdentifier('');
      setPassword('');
      onConnected();
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    if (!mfaId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyConnectionMfa(token, mfaId, mfaCode.trim());
      setMsg('Garmin connected — pull to refresh and sync.');
      setMfaId(null);
      setMfaCode('');
      onConnected();
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = [
    styles.input,
    { color: theme.text, backgroundColor: theme.backgroundElement },
  ];
  const passwordLabel =
    provider === 'omron'
      ? 'Omron email or username'
      : provider === 'garmin'
        ? 'Garmin email'
        : provider === 'zwift'
          ? 'Zwift account email'
          : 'iGPSPORT username';

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.headingRow}>
        <Text style={[styles.heading, { color: theme.text }]}>Add a connection</Text>
        <Text style={{ color: theme.textSecondary }}>{open ? '−' : '+'}</Text>
      </Pressable>

      {open && (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.providers}>
              {(Object.keys(LABELS) as Provider[]).map((p) => (
                <Pressable
                  key={p}
                  onPress={() => pick(p)}
                  style={[
                    styles.provider,
                    {
                      backgroundColor: provider === p ? '#208AEF' : theme.backgroundSelected,
                    },
                  ]}
                >
                  <Text style={{ color: provider === p ? '#fff' : theme.text }}>{LABELS[p]}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          {provider !== 'strava' && (
            <>
              <TextInput
                style={inputStyle}
                value={identifier}
                onChangeText={setIdentifier}
                placeholder={passwordLabel}
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoComplete="off"
              />
              <TextInput
                style={inputStyle}
                value={password}
                onChangeText={setPassword}
                placeholder="password (verified, never stored in clear)"
                placeholderTextColor={theme.textSecondary}
                secureTextEntry
                autoComplete="off"
              />
              {provider === 'omron' && (
                <TextInput
                  style={inputStyle}
                  value={country}
                  onChangeText={(v) => setCountry(v.toUpperCase().slice(0, 2))}
                  placeholder="Omron country code (e.g. AR)"
                  placeholderTextColor={theme.textSecondary}
                  autoCapitalize="characters"
                  maxLength={2}
                />
              )}
            </>
          )}

          <Pressable
            onPress={() => void connect()}
            disabled={busy}
            style={[styles.save, busy && styles.disabled]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.saveText}>
                {provider === 'strava' ? 'Open Strava consent' : 'Connect'}
              </Text>
            )}
          </Pressable>

          {mfaId && (
            <View style={styles.mfa}>
              <TextInput
                style={inputStyle}
                value={mfaCode}
                onChangeText={setMfaCode}
                placeholder={`${mfaMethod} code`}
                placeholderTextColor={theme.textSecondary}
                keyboardType="number-pad"
              />
              <Pressable
                onPress={() => void verify()}
                disabled={busy || !mfaCode.trim()}
                style={[styles.save, (busy || !mfaCode.trim()) && styles.disabled]}
              >
                <Text style={styles.saveText}>Verify</Text>
              </Pressable>
            </View>
          )}

          {msg && <Text style={{ color: '#2e7d32' }}>{msg}</Text>}
          {error && <Text style={styles.error}>{error}</Text>}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, padding: Spacing.three, gap: Spacing.two },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 18, fontWeight: '700' },
  providers: { flexDirection: 'row', gap: Spacing.two, paddingVertical: Spacing.two },
  provider: { borderRadius: 8, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  input: { borderRadius: 8, paddingHorizontal: Spacing.two, paddingVertical: Spacing.two },
  save: {
    backgroundColor: '#208AEF',
    borderRadius: 8,
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  saveText: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.6 },
  mfa: { gap: Spacing.two },
  error: { color: '#b02a2a' },
});
