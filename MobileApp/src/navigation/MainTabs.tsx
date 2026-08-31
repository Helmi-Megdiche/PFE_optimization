import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from './types';
import { MonitorScreen } from '../screens/MonitorScreen';
import { MissionListScreen } from '../screens/MissionListScreen';
import { RewardsStoreScreen } from '../screens/RewardsStoreScreen';
import { BadgesScreen } from '../screens/BadgesScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { colors, radius, type as typeScale } from '../theme';

const Tab = createBottomTabNavigator<MainTabParamList>();

const ICONS: Record<keyof MainTabParamList, string> = {
  Monitor: '🛡️',
  Missions: '🎯',
  Rewards: '🎁',
  Badges: '🏅',
  Profile: '🙂',
};

function TabIcon({ name, focused }: { name: keyof MainTabParamList; focused: boolean }) {
  return (
    <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
      <Text style={[styles.icon, { opacity: focused ? 1 : 0.55 }]}>{ICONS[name]}</Text>
    </View>
  );
}

export function MainTabs(): React.JSX.Element {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        headerStyle: styles.header,
        headerShadowVisible: false,
        headerTitleStyle: typeScale.heading,
        headerTitleAlign: 'left',
        headerTintColor: colors.ink,
        tabBarActiveTintColor: colors.tealDeep,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabLabel,
        tabBarItemStyle: styles.tabItem,
        tabBarIcon: ({ focused }) => (
          <TabIcon name={route.name as keyof MainTabParamList} focused={focused} />
        ),
      })}>
      <Tab.Screen name="Monitor" component={MonitorScreen} options={{ title: 'SafeGuard' }} />
      <Tab.Screen name="Missions" component={MissionListScreen} options={{ title: 'Missions' }} />
      <Tab.Screen name="Rewards" component={RewardsStoreScreen} options={{ title: 'Rewards' }} />
      <Tab.Screen name="Badges" component={BadgesScreen} options={{ title: 'Badges' }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.sand,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  tabBar: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    height: Platform.OS === 'android' ? 66 : 84,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'android' ? 10 : 24,
  },
  tabItem: { paddingTop: 2 },
  tabLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2, marginTop: 2 },
  iconWrap: {
    width: 46,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapActive: { backgroundColor: colors.tealSoft },
  icon: { fontSize: 17 },
});
