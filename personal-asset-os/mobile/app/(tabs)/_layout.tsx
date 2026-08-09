import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { palette } from '@/src/theme/tokens';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.caramelDark,
        tabBarInactiveTintColor: palette.cocoaMuted,
        tabBarHideOnKeyboard: true,
        tabBarLabelStyle: { fontSize: 13, fontWeight: '700', marginTop: 1 },
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
          height: 76,
          paddingTop: 8,
          paddingBottom: 9,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: '記一筆',
          tabBarIcon: ({ color, focused }) => (
            <MaterialCommunityIcons
              name={focused ? 'pencil-circle' : 'pencil-circle-outline'}
              size={29}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="outbox"
        options={{
          title: '待同步',
          tabBarIcon: ({ color, focused }) => (
            <MaterialCommunityIcons
              name={focused ? 'cloud-upload' : 'cloud-upload-outline'}
              size={28}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, focused }) => (
            <MaterialCommunityIcons
              name={focused ? 'account-circle' : 'account-circle-outline'}
              size={29}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
