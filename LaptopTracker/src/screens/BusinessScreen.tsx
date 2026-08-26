import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, Dimensions, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { ServerService } from '../services/ServerService';

const { width } = Dimensions.get('window');

interface Sale {
  id: number;
  total: number;
  time: string;
}

interface Props {
  serverService: ServerService;
  laptopDeviceId: string;
}

export default function BusinessScreen({ serverService, laptopDeviceId }: Props) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const unsub = serverService.onMessage((msg) => {
      if (msg.type === 'pos_update') {
        setSales(prev => [msg.sale, ...prev]);
      }
      if (msg.type === 'inventory_data') {
        setInventory(msg.data);
        setLoading(false);
      }
    });

    // Request initial inventory
    setLoading(true);
    serverService.send({ type: 'command', commandType: 'inventory_check' });

    return unsub;
  }, [serverService]);

  const totalRevenue = sales.reduce((acc, s) => acc + s.total, 0);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Business Guardian</Text>
        <Text style={styles.subtitle}>Real-time Sales & Inventory</Text>
      </View>

      <View style={styles.statRow}>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>REVENUE</Text>
          <Text style={styles.statValue}>${totalRevenue.toFixed(2)}</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>SALES</Text>
          <Text style={styles.statValue}>{sales.length}</Text>
        </View>
      </View>

      <View style={styles.content}>
        <Text style={styles.secTitle}>Live Sales Feed</Text>
        <FlatList
          data={sales}
          keyExtractor={(item) => item.id.toString()}
          renderItem={({ item }) => (
            <View style={styles.saleItem}>
              <View>
                <Text style={styles.saleTitle}>Transaction #{item.id.toString().slice(-4)}</Text>
                <Text style={styles.saleTime}>{new Date(item.time).toLocaleTimeString()}</Text>
              </View>
              <Text style={styles.saleAmount}>+${item.total.toFixed(2)}</Text>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.empty}>Waiting for sales sync...</Text>}
          style={styles.list}
        />

        <View style={styles.invHeader}>
          <Text style={styles.secTitle}>Remote Inventory</Text>
          <TouchableOpacity onPress={() => {
            setLoading(true);
            serverService.send({ type: 'command', commandType: 'inventory_check' });
          }}>
            <Text style={styles.refresh}>REFRESH</Text>
          </TouchableOpacity>
        </View>
        
        {loading ? (
          <ActivityIndicator color="#00d4ff" style={{ marginTop: 20 }} />
        ) : (
          <FlatList
            data={inventory}
            keyExtractor={(item, index) => index.toString()}
            renderItem={({ item }) => (
              <View style={styles.invItem}>
                <Text style={styles.invName}>{item.name}</Text>
                <Text style={styles.invPrice}>${item.price.toFixed(2)}</Text>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.empty}>No inventory data received.</Text>}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050508', paddingTop: 60 },
  header: { paddingHorizontal: 25, marginBottom: 20 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  subtitle: { fontSize: 12, color: '#00d4ff', fontWeight: 'bold', letterSpacing: 1 },
  statRow: { flexDirection: 'row', paddingHorizontal: 20, gap: 15, marginBottom: 25 },
  statBox: { flex: 1, backgroundColor: '#0f0f15', padding: 20, borderRadius: 15, borderWidth: 1, borderColor: '#ffffff11' },
  statLabel: { fontSize: 9, color: '#666', fontWeight: 'bold', marginBottom: 5 },
  statValue: { fontSize: 20, fontWeight: 'bold', color: '#00ff88' },
  content: { flex: 1, paddingHorizontal: 25 },
  secTitle: { fontSize: 12, fontWeight: 'bold', color: '#444', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 15 },
  list: { maxHeight: 250, marginBottom: 20 },
  saleItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0f0f15', padding: 15, borderRadius: 12, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#00ff88' },
  saleTitle: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  saleTime: { color: '#444', fontSize: 11 },
  saleAmount: { color: '#00ff88', fontWeight: 'bold', fontSize: 16 },
  invHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  refresh: { color: '#00d4ff', fontSize: 11, fontWeight: 'bold' },
  invItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ffffff05' },
  invName: { color: '#aaa', fontSize: 14 },
  invPrice: { color: '#fff', fontWeight: 'bold' },
  empty: { color: '#333', fontSize: 12, textAlign: 'center', marginTop: 10 }
});
