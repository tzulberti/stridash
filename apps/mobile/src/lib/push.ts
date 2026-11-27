import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushToken } from './api';

export type PushRegistration = 'registered' | 'denied' | 'skipped';

function projectId(): string | null {
  const configured =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return configured?.trim() || null;
}

/** Ask for notification permission and register the Expo push token with the
 * Stridash API. No-op on web or when no EAS project id is configured. */
export async function registerForPush(token: string): Promise<PushRegistration> {
  if (Platform.OS === 'web') return 'skipped';
  const project = projectId();
  if (!project) return 'skipped';

  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') {
    permission = await Notifications.requestPermissionsAsync();
  }
  if (permission.status !== 'granted') return 'denied';

  const pushToken = (await Notifications.getExpoPushTokenAsync({ projectId: project })).data;
  await registerPushToken(token, pushToken, Platform.OS === 'ios' ? 'ios' : 'android');
  return 'registered';
}
