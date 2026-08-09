import type { TextStyle, ViewStyle } from 'react-native';

export const palette = {
  canvas: '#F7F0E7',
  canvasStrong: '#F1E5D6',
  surface: '#FFFDF9',
  surfaceMuted: '#F4EBDD',
  border: '#D8C6B0',
  borderStrong: '#BBA58D',
  cocoa: '#3F2E25',
  cocoaMuted: '#765F51',
  caramel: '#B87746',
  caramelDark: '#95582D',
  sage: '#718068',
  sageSoft: '#E6EBDD',
  amberSoft: '#F7E7C8',
  danger: '#A94E3C',
  white: '#FFFFFF',
  shadow: '#6F4F3D',
} as const;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 44,
} as const;

export const radii = {
  sm: 10,
  md: 16,
  lg: 22,
  pill: 999,
} as const;

export const shadows: Record<'soft', ViewStyle> = {
  soft: {
    shadowColor: palette.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 3,
  },
};
export const typeStyles: Record<'eyebrow' | 'title' | 'section' | 'body' | 'caption', TextStyle> = {
  eyebrow: {
    color: palette.caramelDark,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  title: {
    color: palette.cocoa,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
    lineHeight: 42,
  },
  section: {
    color: palette.cocoa,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 27,
  },
  body: {
    color: palette.cocoaMuted,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 24,
  },
  caption: {
    color: palette.cocoaMuted,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 19,
  },
};
