import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch, Alert } from 'react-native';
import DeviceInfo from 'react-native-device-info';

interface Props {
  onUnpair: () => void;
}

export default function SettingsScreen({ onUnpair }: Props) {
  const [deviceInfo, setDeviceInfo] = useState<any>({});

  useEffect(() => {
    (async () => {
      setDeviceInfo({
        model: await DeviceInfo.getModel(),
        brand: await DeviceInfo.getBrand(),
        os: await DeviceInfo.getSystemName(),
        version: await DeviceInfo.getSystemVersion(),
        battery: Math.round((await DeviceInfo.getBatteryLevel()) * 100) + '%',
        id: await DeviceInfo.getUniqueId(),
      });
    })();
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Device Info</Text>
        <InfoRow label="Model" value={deviceInfo.model || '--'} />
        <InfoRow label="Brand" value={deviceInfo.brand || '--'} />
        <InfoRow label="OS" value={`${deviceInfo.os || '--'} ${deviceInfo.version || ''}`} />
        <InfoRow label="Battery" value={deviceInfo.battery || '--'} />
        <InfoRow label="Device ID" value={deviceInfo.id || '--'} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connection</Text>
        <InfoRow label="Protocol" value="WebSocket + HTTP" />
        <InfoRow label="Location" value="GPS + IP Fallback" />
        <InfoRow label="Encryption" value="WSS (TLS)" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Background</Text>
        <InfoRow label="GPS Tracking" value="Continuous" />
        <InfoRow label="Heartbeat" value="Every 15s" />
        <InfoRow label="Background Mode" value="Enabled" />
      </View>

      <TouchableOpacity style={styles.dangerBtn} onPress={() => {
        Alert.alert('Unpair Device', 'Remove all pairing data?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Unpair', style: 'destructive', onPress: onUnpair },
        ]);
      }}>
        <Text style={styles.dangerText}>Unpair Device</Text>
      </TouchableOpacity>

      <Text style={styles.version}>Laptop Tracker v3.0.0</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f', padding: 16 },
  header: { paddingTop: 48, paddingBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff' },
  section: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#ffffff11' },
  sectionTitle: { fontSize: 10, fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ffffff08' },
  infoLabel: { fontSize: 13, color: '#aaa' },
  infoValue: { fontSize: 13, color: '#00d4ff', fontFamily: 'monospace' },
  dangerBtn: { backgroundColor: 'rgba(255,68,68,0.15)', borderWidth: 1, borderColor: 'rgba(255,68,68,0.3)', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 20 },
  dangerText: { color: '#ff4444', fontSize: 15, fontWeight: '600' },
  version: { textAlign: 'center', color: '#444', fontSize: 11, marginTop: 20 },
});
