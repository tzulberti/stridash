import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  loadDashboard,
  syncConnection,
  type DashboardData,
  type MobileConnection,
} from '@/lib/api';

function dateOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function distance(m: number | null | undefined): string {
  if (m == null) return '—';
  return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
}

function duration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function providerName(provider: string): string {
  const names: Record<string, string> = {
    OMRON: 'Omron',
    IGPSPORT: 'iGPSPORT',
    GARMIN: 'Garmin',
    ZWIFT: 'Zwift',
    STRAVA: 'Strava',
  };
  return names[provider] ?? provider;
}

export function DashboardScreen(props: { token: string; onSignOut: () => void }) {
  const { token, onSignOut } = props;
  const theme = useTheme();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadDashboard(token));
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // Initial/first-token fetch; subsequent refreshes come from pull-to-refresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch starts with loading=true
    void load();
  }, [load]);

  async function sync(connection: MobileConnection): Promise<void> {
    setSyncNote(null);
    try {
      await syncConnection(connection.id, token);
      setSyncNote(`${providerName(connection.provider)} sync queued`);
      setTimeout(() => void load(), 2_000);
    } catch (err) {
      setSyncNote(String(err).replace(/^Error: /, ''));
    }
  }

  const latestWeight = data?.measurements.find((m) => m.weightKg != null);
  const latestSleep = data?.sleeps.find((s) => s.totalSleepS != null);
  const latestWellness = data?.wellness.find((w) => w.steps != null);
  const activeConnections = data?.connections.filter((c) => c.status === 'ACTIVE').length ?? 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void load()}
            tintColor={theme.text}
          />
        }
      >
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: theme.text }]}>🦾 Stridash</Text>
            <Text style={{ color: theme.textSecondary }}>
              {data?.me.displayName ?? 'Loading…'}
              {data?.me.email ? ` · ${data.me.email}` : ''}
            </Text>
          </View>
          <Pressable
            onPress={onSignOut}
            style={[styles.smallButton, { backgroundColor: theme.backgroundElement }]}
          >
            <Text style={{ color: theme.text }}>Sign out</Text>
          </Pressable>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        {syncNote && <Text style={{ color: theme.textSecondary }}>{syncNote}</Text>}
        {!data && loading && <ActivityIndicator style={styles.loading} color={theme.text} />}

        {data && (
          <>
            <View style={styles.cards}>
              <Stat
                label="Latest weight"
                value={latestWeight?.weightKg != null ? `${latestWeight.weightKg} kg` : '—'}
                theme={theme}
              />
              <Stat
                label="Body fat"
                value={latestWeight?.bodyFatPct != null ? `${latestWeight.bodyFatPct}%` : '—'}
                theme={theme}
              />
              <Stat
                label="Latest sleep"
                value={latestSleep?.totalSleepS != null ? duration(latestSleep.totalSleepS) : '—'}
                theme={theme}
              />
              <Stat label="Sleep score" value={latestSleep?.sleepScore ?? '—'} theme={theme} />
              <Stat
                label="Latest steps"
                value={latestWellness?.steps?.toLocaleString() ?? '—'}
                theme={theme}
              />
              <Stat
                label="Resting HR"
                value={latestWellness?.restingHr != null ? `${latestWellness.restingHr} bpm` : '—'}
                theme={theme}
              />
              <Stat label="Recent activities" value={data.activities.length} theme={theme} />
              <Stat
                label="Active connections"
                value={`${activeConnections}/${data.connections.length}`}
                theme={theme}
              />
            </View>

            <Text style={[styles.sectionTitle, { color: theme.text }]}>Connections</Text>
            {data.connections.length === 0 && (
              <Text style={{ color: theme.textSecondary }}>
                No providers linked yet — connect them in the web dashboard.
              </Text>
            )}
            {data.connections.map((c) => (
              <View key={c.id} style={[styles.row, { backgroundColor: theme.backgroundElement }]}>
                <View style={styles.rowText}>
                  <Text style={{ color: theme.text, fontWeight: '600' }}>
                    {providerName(c.provider)}
                  </Text>
                  <Text style={{ color: theme.textSecondary }}>
                    {c.status.toLowerCase()} · last sync {dateOf(c.lastSyncedAt)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void sync(c)}
                  disabled={c.status !== 'ACTIVE'}
                  style={[
                    styles.smallButton,
                    { backgroundColor: theme.backgroundSelected },
                    c.status !== 'ACTIVE' && styles.disabled,
                  ]}
                >
                  <Text style={{ color: theme.text }}>Sync</Text>
                </Pressable>
              </View>
            ))}

            <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent activities</Text>
            {data.activities.length === 0 && (
              <Text style={{ color: theme.textSecondary }}>No activities yet.</Text>
            )}
            {data.activities.map((a) => (
              <View key={a.id} style={[styles.row, { backgroundColor: theme.backgroundElement }]}>
                <View style={styles.rowText}>
                  <Text style={{ color: theme.text, fontWeight: '600' }} numberOfLines={1}>
                    {a.headline}
                  </Text>
                  <Text style={{ color: theme.textSecondary }}>
                    {a.type.toLowerCase()} · {dateOf(a.startTime)} · {distance(a.distanceM)} ·{' '}
                    {duration(a.durationS)}
                  </Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat(props: {
  label: string;
  value: string | number;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    <View style={[styles.stat, { backgroundColor: props.theme.backgroundElement }]}>
      <Text style={{ color: props.theme.textSecondary, fontSize: 12 }}>{props.label}</Text>
      <Text style={{ color: props.theme.text, fontSize: 22, fontWeight: '700' }}>
        {props.value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.two, paddingBottom: Spacing.six },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  headerText: { flex: 1 },
  title: { fontSize: 30, fontWeight: '700' },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  stat: { width: '47%', borderRadius: 12, padding: Spacing.three, gap: 2 },
  sectionTitle: { fontSize: 20, fontWeight: '700', marginTop: Spacing.three },
  row: {
    borderRadius: 12,
    padding: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rowText: { flex: 1, gap: 2 },
  smallButton: { borderRadius: 8, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  disabled: { opacity: 0.4 },
  error: { color: '#b02a2a' },
  loading: { marginTop: Spacing.four },
});
