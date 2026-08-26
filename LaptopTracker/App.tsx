import React, { useState, useEffect, useCallback } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar, LogBox } from 'react-native';
import PairScreen from './src/screens/PairScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import BusinessScreen from './src/screens/BusinessScreen';
import { ServerService } from './src/services/ServerService';
import { LocationService } from './src/services/LocationService';
import AsyncStorage from '@react-native-async-storage/async-storage';

LogBox.ignoreLogs(['new NativeEventEmitter']);

const Tab = createBottomTabNavigator();
const SERVER_URL = 'https://laptop-tracker-k9vi.onrender.com';

export default function App() {
  const [isPaired, setIsPaired] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [laptopDeviceId, setLaptopDeviceId] = useState<string | null>(null);
  const [serverService, setServerService] = useState<ServerService | null>(null);

  useEffect(() => {
    (async () => {
      const savedId = await AsyncStorage.getItem('deviceId');
      const savedLaptop = await AsyncStorage.getItem('laptopDeviceId');
      if (savedId && savedLaptop) {
        setDeviceId(savedId);
        setLaptopDeviceId(savedLaptop);
        setIsPaired(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (isPaired && deviceId) {
      const svc = new ServerService(SERVER_URL, deviceId, 'phone');
      svc.connect();
      setServerService(svc);

      LocationService.startTracking(deviceId, 'phone', svc);

      return () => {
        svc.disconnect();
        LocationService.stopTracking();
      };
    }
  }, [isPaired, deviceId]);

  const handlePair = useCallback(async (code: string, newDeviceId: string, newLaptopId: string) => {
    setDeviceId(newDeviceId);
    setLaptopDeviceId(newLaptopId);
    setIsPaired(true);
    await AsyncStorage.setItem('deviceId', newDeviceId);
    await AsyncStorage.setItem('laptopDeviceId', newLaptopId);
  }, []);

  const handleUnpair = useCallback(async () => {
    setIsPaired(false);
    setDeviceId(null);
    setLaptopDeviceId(null);
    serverService?.disconnect();
    await AsyncStorage.multiRemove(['deviceId', 'laptopDeviceId']);
  }, [serverService]);

  if (!isPaired) {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor="#0a0a0f" />
        <PairScreen serverUrl={SERVER_URL} onPair={handlePair} />
      </>
    );
  }

  return (
    <>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0f" />
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarStyle: { backgroundColor: '#0a0a0f', borderTopColor: '#ffffff11', height: 60, paddingBottom: 8 },
            tabBarActiveTintColor: '#00d4ff',
            tabBarInactiveTintColor: '#444',
          }}
        >
          <Tab.Screen name="Tracker" options={{ tabBarIcon: () => <Text>📍</Text> }}>
            {props => (
              <DashboardScreen
                {...props}
                deviceId={deviceId!}
                laptopDeviceId={laptopDeviceId!}
                serverService={serverService!}
              />
            )}
          </Tab.Screen>
          <Tab.Screen name="Business" options={{ tabBarIcon: () => <Text>💼</Text> }}>
            {props => (
              <BusinessScreen
                {...props}
                serverService={serverService!}
                laptopDeviceId={laptopDeviceId!}
              />
            )}
          </Tab.Screen>
          <Tab.Screen name="Settings" options={{ tabBarIcon: () => <Text>⚙️</Text> }}>
            {props => <SettingsScreen {...props} onUnpair={handleUnpair} />}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>
    </>
  );
}

import { Text } from 'react-native';
