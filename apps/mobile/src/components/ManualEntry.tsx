import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { createMeasurement, type ManualMeasurement } from '@/lib/api';

type Kind = ManualMeasurement['kind'];

function numberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Phone quick-add for a weigh-in or blood-pressure reading. The server
 * assigns the measurement timestamp (now) and provider MANUAL. */
export function ManualEntry(props: { token: string; onSaved: () => void }) {
  const { token, onSaved } = props;
  const theme = useTheme();
  const [kind, setKind] = useState<Kind>('WEIGH_IN');
  const [weight, setWeight] = useState('');
  const [bodyFat, setBodyFat] = useState('');
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [pulse, setPulse] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const measurement: ManualMeasurement =
        kind === 'WEIGH_IN'
          ? {
              kind,
              weightKg: Number(weight),
              ...(numberOrUndefined(bodyFat) !== undefined
                ? { bodyFatPct: numberOrUndefined(bodyFat) }
                : {}),
            }
          : {
              kind,
              systolicMmhg: Number(systolic),
              diastolicMmhg: Number(diastolic),
              ...(numberOrUndefined(pulse) !== undefined
                ? { pulseBpm: numberOrUndefined(pulse) }
                : {}),
            };
      await createMeasurement(token, measurement);
      setMsg('Measurement saved');
      if (kind === 'WEIGH_IN') {
        setWeight('');
        setBodyFat('');
      } else {
        setSystolic('');
        setDiastolic('');
        setPulse('');
      }
      onSaved();
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

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <Text style={[styles.heading, { color: theme.text }]}>Log a measurement</Text>
      <View style={styles.tabs}>
        <Pressable
          onPress={() => {
            setKind('WEIGH_IN');
            setMsg(null);
            setError(null);
          }}
          style={[
            styles.tab,
            { backgroundColor: kind === 'WEIGH_IN' ? '#208AEF' : theme.backgroundSelected },
          ]}
        >
          <Text style={{ color: kind === 'WEIGH_IN' ? '#fff' : theme.text }}>Weight</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setKind('BLOOD_PRESSURE');
            setMsg(null);
            setError(null);
          }}
          style={[
            styles.tab,
            { backgroundColor: kind === 'BLOOD_PRESSURE' ? '#208AEF' : theme.backgroundSelected },
          ]}
        >
          <Text style={{ color: kind === 'BLOOD_PRESSURE' ? '#fff' : theme.text }}>
            Blood pressure
          </Text>
        </Pressable>
      </View>

      {kind === 'WEIGH_IN' ? (
        <View style={styles.rowInputs}>
          <View style={styles.field}>
            <Text style={{ color: theme.textSecondary }}>Weight (kg)</Text>
            <TextInput
              style={inputStyle}
              value={weight}
              onChangeText={setWeight}
              keyboardType="decimal-pad"
              placeholder="82.5"
              placeholderTextColor={theme.textSecondary}
            />
          </View>
          <View style={styles.field}>
            <Text style={{ color: theme.textSecondary }}>Body fat (%)</Text>
            <TextInput
              style={inputStyle}
              value={bodyFat}
              onChangeText={setBodyFat}
              keyboardType="decimal-pad"
              placeholder="optional"
              placeholderTextColor={theme.textSecondary}
            />
          </View>
        </View>
      ) : (
        <View style={styles.rowInputs}>
          <View style={styles.field}>
            <Text style={{ color: theme.textSecondary }}>Systolic</Text>
            <TextInput
              style={inputStyle}
              value={systolic}
              onChangeText={setSystolic}
              keyboardType="number-pad"
              placeholder="120"
              placeholderTextColor={theme.textSecondary}
            />
          </View>
          <View style={styles.field}>
            <Text style={{ color: theme.textSecondary }}>Diastolic</Text>
            <TextInput
              style={inputStyle}
              value={diastolic}
              onChangeText={setDiastolic}
              keyboardType="number-pad"
              placeholder="80"
              placeholderTextColor={theme.textSecondary}
            />
          </View>
          <View style={styles.field}>
            <Text style={{ color: theme.textSecondary }}>Pulse</Text>
            <TextInput
              style={inputStyle}
              value={pulse}
              onChangeText={setPulse}
              keyboardType="number-pad"
              placeholder="optional"
              placeholderTextColor={theme.textSecondary}
            />
          </View>
        </View>
      )}

      <Pressable
        onPress={() => void submit()}
        disabled={busy}
        style={[styles.save, busy && styles.disabled]}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save</Text>}
      </Pressable>
      {msg && <Text style={{ color: '#2e7d32' }}>{msg}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, padding: Spacing.three, gap: Spacing.two },
  heading: { fontSize: 18, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: Spacing.two },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: 8,
  },
  rowInputs: { flexDirection: 'row', gap: Spacing.two },
  field: { flex: 1, gap: 2 },
  input: { borderRadius: 8, paddingHorizontal: Spacing.two, paddingVertical: Spacing.two },
  save: {
    backgroundColor: '#208AEF',
    borderRadius: 8,
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  saveText: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.6 },
  error: { color: '#b02a2a' },
});
