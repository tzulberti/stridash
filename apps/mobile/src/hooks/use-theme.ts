import { useColorScheme } from 'react-native';

import { Colors, ThemeColor } from '@/constants/theme';

export type Theme = { dark: boolean } & Record<ThemeColor, string>;

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  return { dark, ...Colors[dark ? 'dark' : 'light'] };
}
