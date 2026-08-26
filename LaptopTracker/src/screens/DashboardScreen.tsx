import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Dimensions, Alert, ActivityIndicator, Image, Modal, FlatList,
} from 'react-native';
import MapView, { Marker, Circle, Polyline } from 'react-native-maps';
import { ServerService, apiGet } from '../services/ServerService';
import { LocationService, Beacon, FusionInput } from '../services/LocationService';

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
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalType, setModalType] = useState<'image' | 'list' | 'text' | 'wifi' | 'network'>('text');
  const [pathHistory, setPathHistory] = useState<any[]>([]);
  const [brainStats, setBrainStats] = useState({ confidence: 0, motion: 'stationary', speed: 0 });
  
  const mapRef = useRef<MapView>(null);

  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const accepted = await LocationService.checkUserAgreement();
      if (!accepted) await LocationService.showAgreement();
    })();

    const logPoll = setInterval(async () => {
        if (laptopDeviceId) {
            try {
                const data = await apiGet(serverService.url, '/api/logs/' + laptopDeviceId);
                if (data.success && data.logs) setLogs(data.logs);
            } catch(e) {}
        }
    }, 5000);

    const unsub = serverService.onMessage((msg) => {
      if (msg.type === 'location' && msg.fromDeviceId === laptopDeviceId) {
        const rawInput: FusionInput = {
          lat: msg.location.lat,
          lng: msg.location.lng,
          accuracy: msg.location.accuracy,
          speed: msg.location.speed || 0,
          source: msg.location.source,
          timestamp: Date.now()
        };
        
        const preciseFix = LocationService.fusePreciseCoordinate([rawInput]);
        setLaptopLocation(preciseFix);
        setBrainStats({ 
            confidence: preciseFix.confidence || 0, 
            motion: preciseFix.speed > 0.5 ? 'moving' : 'stationary', 
            speed: preciseFix.speed 
        });
        
        setPathHistory(prev => [...prev.slice(-29), { latitude: preciseFix.lat, longitude: preciseFix.lng }]);
      }

      if (msg.type === 'forensic_log') {
          setLogs(prev => [msg.log, ...prev].slice(0, 50));
      }

      if (msg.type === 'commandResult') {
        setLoading(false);
        const res = typeof msg.result === 'string' ? JSON.parse(msg.result) : msg.result;
        setLastResult(res);
        
        if (res.image) setModalType('image');
        else if (res.bssids) setModalType('wifi');
        else if (res.arp) setModalType('network');
        else setModalType('text');
        setModalVisible(true);
      }
    });
    return () => { unsub(); clearInterval(logPoll); };
  }, [serverService, laptopDeviceId]);

  const sendCommand = useCallback(async (type: string, params = {}) => {
    setLoading(true);
    serverService.send({ type: 'command', commandType: type, params });
  }, [serverService]);

  const renderLogItem = ({ item }: { item: any }) => {
    const ts = new Date(Number(item.createdAt)).toLocaleTimeString();
    const color = item.level === 'warning' ? '#f59e0b' : item.level === 'error' ? '#ef4444' : '#00ff88';
    return (
        <View style={styles.logItem}>
            <Text style={styles.logTs}>[{ts}]</Text>
            <Text style={styles.logTool}>[{item.tool.toUpperCase()}]</Text>
            <Text style={[styles.logMsg, { color }]}>{item.output.substring(0, 100)}</Text>
        </View>
    );
  };

  const renderModalContent = () => {
    if (!lastResult) return null;
    if (modalType === 'image') return <Image source={{ uri: `data:image/png;base64,${lastResult.image}` }} style={styles.fullImage} resizeMode="contain" />;
    
    if (modalType === 'wifi') {
      return (
        <FlatList
          data={lastResult.bssids}
          renderItem={({ item }) => (
            <View style={styles.resItem}>
              <View style={styles.resHeader}>
                <Text style={styles.resTitle}>{item.ssid || 'HIDDEN'}</Text>
                <Text style={styles.resSubtitle}>{item.rssi} dBm</Text>
              </View>
              <Text style={styles.resDetail}>MAC: {item.bssid}</Text>
              <Text style={styles.resDetail}>Proximity: ~{LocationService.rssiToMeters(item.rssi).toFixed(1)}m</Text>
            </View>
          )}
        />
      );
    }

    if (modalType === 'network') {
      return <Text style={styles.modalText}>{lastResult.arp}</Text>;
    }

    return <Text style={styles.modalText}>{JSON.stringify(lastResult, null, 2)}</Text>;
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerInfo}>
          <Text style={styles.headerName}>{laptopInfo.hostname || 'Detecting...'}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, laptopOnline ? styles.online : styles.offline]} />
            <Text style={styles.statusText}>{laptopOnline ? 'SECURE AGENT CONNECTED' : 'NODE DISCONNECTED'}</Text>
          </View>
        </View>
        <View style={styles.distBox}>
          <Text style={styles.distanceValue}>{distance}</Text>
          <Text style={styles.distanceLabel}>PROXIMITY</Text>
        </View>
      </View>

      <View style={styles.mapWrap}>
        <MapView
          ref={mapRef}
          style={styles.map}
          initialRegion={{ latitude: 0, longitude: 0, latitudeDelta: 0.01, longitudeDelta: 0.01 }}
          showsUserLocation
          customMapStyle={darkMapStyle}
        >
          {laptopLocation && (
            <>
              <Marker coordinate={{ latitude: laptopLocation.lat, longitude: laptopLocation.lng }}>
                <View style={styles.marker}><Text style={styles.markerIcon}>💻</Text></View>
              </Marker>
              <Circle
                center={{ latitude: laptopLocation.lat, longitude: laptopLocation.lng }}
                radius={laptopLocation.accuracy || 50}
                strokeColor="#00d4ff"
                fillColor="#00d4ff11"
                strokeWidth={2}
              />
              <Polyline coordinates={pathHistory} strokeColor="#00d4ff" strokeWidth={3} lineDashPattern={[5, 5]} />
            </>
          )}
        </MapView>
        {loading && <View style={styles.loadingOverlay}><ActivityIndicator color="#00d4ff" /><Text style={styles.loadingMsg}>Engaging Forensic Logic...</Text></View>}
      </View>

      <ScrollView style={styles.panel} showsVerticalScrollIndicator={false}>
        <View style={styles.brainCard}>
           <Text style={styles.secTitle}>TTAL Fusion Brain (v9.0)</Text>
           <View style={styles.brainGrid}>
              <BrainStat label="Confidence" value={`${brainStats.confidence}%`} color="#00ff88" />
              <BrainStat label="Motion" value={brainStats.motion.toUpperCase()} color="#00f2ff" />
              <BrainStat label="Accuracy" value={laptopLocation ? (laptopLocation.accuracy < 1000 ? Math.round(laptopLocation.accuracy) + 'm' : (laptopLocation.accuracy/1000).toFixed(1) + 'km') : '--'} color="#f59e0b" />
           </View>
        </View>

        <View style={styles.terminal}>
           <View style={styles.terminalHeader}>
              <Text style={styles.terminalTitle}>FORENSIC TERMINAL</Text>
              <View style={styles.liveDot} />
           </View>
           <FlatList
             data={logs}
             renderItem={renderLogItem}
             keyExtractor={(_, index) => index.toString()}
             style={{ maxHeight: 150 }}
             scrollEnabled={true}
           />
        </View>

        <Text style={styles.secTitle}>Forensic Acquisition</Text>
        <View style={styles.toolGrid}>
          <ToolCard icon="📍" label="Locate" sub="Force GPS" onPress={() => sendCommand('locate')} color="#00ff88" />
          <ToolCard icon="🌐" label="DNS Dump" sub="Browse Intel" onPress={() => sendCommand('dns-dump')} color="#00f2ff" />
          <ToolCard icon="🔍" label="Port Audit" sub="Vulnerability" onPress={() => sendCommand('port-audit')} color="#a855f7" />
          <ToolCard icon="📡" label="Signal" sub="WiFi/BSSID" onPress={() => sendCommand('wifi-scan')} color="#3b82f6" />
        </View>

        <Text style={styles.secTitle}>Ethical Hacking / Security</Text>
        <View style={styles.toolGrid}>
          <ToolCard icon="💾" label="USB Audit" sub="Drive Hist" onPress={() => sendCommand('usb-audit')} color="#f59e0b" />
          <ToolCard icon="🚀" label="Startup" sub="Persistence" onPress={() => sendCommand('persistence')} color="#ef4444" />
          <ToolCard icon="🔒" label="Lock" sub="Workstation" onPress={() => sendCommand('lock')} color="#00f2ff" />
          <ToolCard icon="🚨" label="Alarm" sub="Sonic Siren" onPress={() => sendCommand('siren')} color="#ff4444" />
        </View>
        <View style={{height: 100}} />
      </ScrollView>

      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalBg}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Forensic Evidence</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)} style={styles.modalClose}><Text style={styles.modalCloseTxt}>DISMISS</Text></TouchableOpacity>
            </View>
            <View style={styles.modalBody}>{renderModalContent()}</View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ToolCard({ icon, label, sub, onPress, color }: any) {
  return (
    <TouchableOpacity style={[styles.toolCard, { borderColor: color + '33' }]} onPress={onPress}>
      <Text style={styles.toolIcon}>{icon}</Text>
      <View>
        <Text style={[styles.toolLabel, { color }]}>{label}</Text>
        <Text style={styles.toolSub}>{sub}</Text>
      </View>
    </TouchableOpacity>
  );
}

function BrainStat({ label, value, color }: any) {
    return (
        <View style={styles.brainStatItem}>
            <Text style={styles.brainStatLabel}>{label}</Text>
            <Text style={[styles.brainStatValue, { color }]}>{value}</Text>
        </View>
    );
}

const darkMapStyle = [{ "elementType": "geometry", "stylers": [{ "color": "#212121" }] }, { "elementType": "labels.text.fill", "stylers": [{ "color": "#757575" }] }, { "featureType": "road", "elementType": "geometry", "stylers": [{ "color": "#2c2c2c" }] }, { "featureType": "water", "elementType": "geometry", "stylers": [{ "color": "#000000" }] }];

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050508' },
  header: { flexDirection: 'row', paddingTop: 60, paddingHorizontal: 25, paddingBottom: 25, backgroundColor: 'rgba(5,5,8,0.8)' },
  headerInfo: { flex: 1 },
  headerName: { fontSize: 20, fontWeight: 'bold', color: '#fff', letterSpacing: -0.5 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8, shadowColor: '#00ff88', shadowRadius: 5, shadowOpacity: 1 },
  online: { backgroundColor: '#00ff88' },
  offline: { backgroundColor: '#ff4444' },
  statusText: { fontSize: 10, color: '#00f2ff', fontWeight: '800', letterSpacing: 1 },
  distBox: { alignItems: 'flex-end', justifyContent: 'center' },
  distanceValue: { fontSize: 22, fontWeight: '800', color: '#fff' },
  distanceLabel: { fontSize: 8, color: '#444', fontWeight: 'bold', letterSpacing: 1 },
  mapWrap: { height: 350, width: width - 32, margin: 16, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  map: { flex: 1 },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5,5,8,0.8)', justifyContent: 'center', alignItems: 'center' },
  loadingMsg: { color: '#00f2ff', marginTop: 10, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  marker: { width: 44, height: 44, backgroundColor: '#00f2ff', borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#fff', shadowColor: '#00f2ff', shadowRadius: 10, shadowOpacity: 0.5 },
  markerIcon: { fontSize: 20 },
  panel: { paddingHorizontal: 16 },
  secTitle: { fontSize: 10, fontWeight: '800', color: '#555', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 15, marginTop: 10 },
  brainCard: { backgroundColor: 'rgba(15,15,25,0.7)', borderRadius: 20, padding: 20, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  brainGrid: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  brainStatItem: { alignItems: 'center' },
  brainStatLabel: { fontSize: 8, color: '#666', textTransform: 'uppercase', marginBottom: 4, letterSpacing: 1 },
  brainStatValue: { fontSize: 16, fontWeight: '800' },
  terminal: { backgroundColor: '#000', borderRadius: 20, padding: 15, marginBottom: 20, borderWidth: 1, borderColor: '#1a1a2a' },
  terminalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(0,255,136,0.1)', paddingBottom: 5 },
  terminalTitle: { color: '#00ff88', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#00ff88' },
  logItem: { flexDirection: 'row', marginBottom: 4, gap: 5 },
  logTs: { color: '#444', fontSize: 9, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  logTool: { color: '#00f2ff', fontSize: 9, fontWeight: '700' },
  logMsg: { fontSize: 9, flex: 1, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  toolGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 15 },
  toolCard: { width: (width - 48) / 2, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,15,25,0.7)', padding: 15, borderRadius: 20, borderWidth: 1, marginBottom: 16 },
  toolIcon: { fontSize: 24, marginRight: 12 },
  toolLabel: { fontSize: 13, fontWeight: '800' },
  toolSub: { fontSize: 8, color: '#444', fontWeight: 'bold', textTransform: 'uppercase' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'flex-end' },
  modalBox: { height: '85%', backgroundColor: '#050508', borderTopLeftRadius: 40, borderTopRightRadius: 40, padding: 25, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 25 },
  modalTitle: { color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  modalClose: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#1a1a2a', borderRadius: 15 },
  modalCloseTxt: { color: '#00f2ff', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  modalBody: { flex: 1 },
  modalText: { color: '#00ff88', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  fullImage: { width: '100%', height: '100%', borderRadius: 24 },
  resItem: { padding: 15, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 15, marginBottom: 12 },
  resHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  resTitle: { color: '#fff', fontWeight: '800', fontSize: 13 },
  resSubtitle: { color: '#00ff88', fontSize: 11, fontWeight: 'bold' },
  resDetail: { color: '#555', fontSize: 10, marginTop: 2 }
});
