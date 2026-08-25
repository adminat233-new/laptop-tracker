import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Dimensions, Alert,
} from 'react-native';
import MapView, { Marker, Polyline, Circle, Callout } from 'react-native-maps';
import { ServerService, apiGet } from '../services/ServerService';
import { CommandService } from '../services/CommandService';
import { LocationService } from '../services/LocationService';

const { width } = Dimensions.get('window');

interface Props {
  deviceId: string;
  laptopDeviceId: string;
  serverService: ServerService;
}

export default function DashboardScreen({ deviceId, laptopDeviceId, serverService }: Props) {
  const [laptopLocation, setLaptopLocation] = useState<any>(null);
  const [laptopOnline, setLaptopOnline] = useState(false);
  const [laptopInfo, setLaptopInfo] = useState<any>({});
  const [distance, setDistance] = useState<string>('--');
  const mapRef = useRef<MapView>(null);

  useEffect(() => {
    const unsub = serverService.onMessage((msg) => {
      if (msg.type === 'location' && msg.fromDeviceId === laptopDeviceId) {
        setLaptopLocation(msg.location);
      }
      if (msg.type === 'commandResult') {
        Alert.alert('Command Result', msg.result);
      }
    });
    return unsub;
  }, [serverService, laptopDeviceId]);

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const data = await apiGet(serverService['serverUrl'], `/api/status/${laptopDeviceId}`);
        setLaptopOnline(data.isOnline);
        setLaptopInfo(data.systemInfo || {});
        if (data.deviceLocation) setLaptopLocation(data.deviceLocation);
      } catch (e) {}
    }, 4000);
    return () => clearInterval(poll);
  }, [laptopDeviceId, serverService]);

  useEffect(() => {
    if (!laptopLocation) return;
    const myLoc = LocationService.getLastLocation();
    if (myLoc) {
      const R = 6371;
      const dLat = (laptopLocation.lat - myLoc.lat) * Math.PI / 180;
      const dLng = (laptopLocation.lng - myLoc.lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(myLoc.lat * Math.PI / 180) * Math.cos(laptopLocation.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      setDistance(d < 1 ? Math.round(d * 1000) + 'm' : d.toFixed(2) + 'km');
    }
  }, [laptopLocation]);

  const sendCommand = useCallback(async (type: string) => {
    Alert.alert('Send Command', `Send "${type}" to laptop?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send', onPress: () => serverService.send({ type: 'command', commandType: type }) },
    ]);
  }, [serverService]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>💻</Text>
        <View style={styles.headerInfo}>
          <Text style={styles.headerName}>{laptopInfo.platform || 'Laptop'}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, laptopOnline ? styles.online : styles.offline]} />
            <Text style={styles.statusText}>{laptopOnline ? 'Online' : 'Offline'}</Text>
          </View>
        </View>
        <Text style={styles.distance}>{distance}</Text>
      </View>

      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{ latitude: 20, longitude: 0, latitudeDelta: 50, longitudeDelta: 50 }}
        showsUserLocation
      >
        {laptopLocation && (
          <>
            <Marker
              coordinate={{ latitude: laptopLocation.lat, longitude: laptopLocation.lng }}
              title="Laptop"
              description={laptopLocation.source || 'unknown'}
            >
              <View style={styles.laptopMarker}><Text>💻</Text></View>
            </Marker>
            <Circle
              center={{ latitude: laptopLocation.lat, longitude: laptopLocation.lng }}
              radius={laptopLocation.accuracy || 10000}
              strokeColor="#00d4ff44"
              fillColor="#00d4ff11"
              strokeWidth={1}
            />
          </>
        )}
      </MapView>

      <ScrollView style={styles.panel}>
        <View style={styles.locationCard}>
          <Text style={styles.sectionTitle}>Laptop Location</Text>
          <Text style={styles.locationText}>
            {laptopLocation ? `${laptopLocation.source || 'unknown'} | Accuracy: ${Math.round(laptopLocation.accuracy || 0)}m` : 'Waiting...'}
          </Text>
          <Text style={styles.locationCoords}>
            {laptopLocation ? `${laptopLocation.lat?.toFixed(6)}, ${laptopLocation.lng?.toFixed(6)}` : '--'}
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Commands</Text>
        <View style={styles.commandGrid}>
          {[
            { icon: '🚨', label: 'Siren', type: 'siren', color: '#ff4444' },
            { icon: '🔔', label: 'Alarm', type: 'alarm', color: '#ff8800' },
            { icon: '🔊', label: 'Noise', type: 'noise', color: '#ff00ff' },
            { icon: '🔒', label: 'Lock', type: 'lock', color: '#00d4ff' },
          ].map(cmd => (
            <TouchableOpacity key={cmd.type} style={[styles.cmdBtn, { backgroundColor: cmd.color + '22', borderColor: cmd.color + '44' }]} onPress={() => sendCommand(cmd.type)}>
              <Text style={styles.cmdIcon}>{cmd.icon}</Text>
              <Text style={[styles.cmdLabel, { color: cmd.color }]}>{cmd.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.commandGrid}>
          {[
            { icon: '📡', label: 'Scan', type: 'netscan' },
            { icon: '📊', label: 'Info', type: 'sysinfo' },
            { icon: '📍', label: 'Locate', type: 'locate' },
            { icon: '📸', label: 'Screen', type: 'screenshot' },
          ].map(cmd => (
            <TouchableOpacity key={cmd.type} style={[styles.cmdBtn, styles.cmdBtnSecondary]} onPress={() => sendCommand(cmd.type)}>
              <Text style={styles.cmdIcon}>{cmd.icon}</Text>
              <Text style={styles.cmdLabel}>{cmd.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 12, paddingTop: 48, backgroundColor: 'rgba(10,10,15,0.95)', borderBottomWidth: 1, borderBottomColor: '#ffffff11' },
  headerIcon: { fontSize: 24, marginRight: 10 },
  headerInfo: { flex: 1 },
  headerName: { fontSize: 14, fontWeight: '600', color: '#fff' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  online: { backgroundColor: '#00ff88' },
  offline: { backgroundColor: '#ff4444' },
  statusText: { fontSize: 11, color: '#888' },
  distance: { fontSize: 12, color: '#00d4ff', fontWeight: '600' },
  map: { width: '100%', height: 300 },
  panel: { flex: 1, padding: 12 },
  locationCard: { backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: '#ffffff11', borderRadius: 16, padding: 14, marginBottom: 12 },
  sectionTitle: { fontSize: 10, fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  locationText: { fontSize: 12, color: '#00d4ff' },
  locationCoords: { fontSize: 10, color: '#7c3aed', fontFamily: 'monospace', marginTop: 4 },
  commandGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  cmdBtn: { width: (width - 48) / 4, padding: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1 },
  cmdBtnSecondary: { backgroundColor: 'rgba(255,255,255,0.08)', borderColor: '#ffffff22' },
  cmdIcon: { fontSize: 20, marginBottom: 4 },
  cmdLabel: { fontSize: 10, fontWeight: '500', color: '#fff' },
  laptopMarker: { width: 36, height: 36, backgroundColor: '#00d4ff', borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#fff' },
});
