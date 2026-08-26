import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, StatusBar, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { apiPost } from '../services/ServerService';

interface Props {
  serverUrl: string;
  onPair: (code: string, deviceId: string, laptopDeviceId: string) => void;
}

export default function PairScreen({ serverUrl, onPair }: Props) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputs = useRef<(TextInput | null)[]>([]);

  const handleCodeChange = (text: string, index: number) => {
    const upper = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
    setCode(prev => {
      const arr = prev.split('');
      arr[index] = upper;
      return arr.join('');
    });
    if (upper && index < 7) {
      inputs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === 'Backspace' && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (text: string) => {
    const cleaned = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    setCode(cleaned);
    if (cleaned.length > 0) {
      inputs.current[Math.min(cleaned.length, 7)]?.focus();
    }
  };

  const handleVerify = async () => {
    if (code.length !== 8) {
      setError('Enter 8 characters');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiPost(serverUrl, '/api/verify', { pairCode: code });
      if (data.success && data.verified) {
        // Use the ID generated automatically by the server
        onPair(code, data.phoneDeviceId, data.laptopDeviceId);
      } else {
        setError(data.error || 'Verification failed');
      }
    } catch (e: any) {
      setError('Network error: ' + e.message);
    }
    setLoading(false);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" backgroundColor="#050508" />

      <View style={styles.heroSection}>
        <Text style={styles.heroTitle}>Guardian Ultimate</Text>
        <Text style={styles.heroSub}>Secure Intelligence & Recovery</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.aiGreeting}>
          <Text style={styles.aiText}>[SYSTEM] Control Mode Active. Please enter the target handshake code to establish uplink.</Text>
        </View>

        <View style={styles.codeContainer}>
          {Array.from({ length: 8 }, (_, i) => (
            <TextInput
              key={i}
              ref={ref => { inputs.current[i] = ref; }}
              style={[styles.codeBox, code[i] ? styles.codeBoxFilled : null]}
              maxLength={1}
              value={code[i] || ''}
              onChangeText={(t) => handleCodeChange(t, i)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, i)}
              onTextInput={({ nativeEvent }) => handlePaste(nativeEvent.text)}
              autoCapitalize="characters"
              autoCorrect={false}
              selectTextOnFocus
              placeholderTextColor="#222"
            />
          ))}
        </View>

        <Text style={styles.binaryDisplay}>
          {code.length > 0 ? 'Binary: ' + code.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ') : 'HANDSHAKE PENDING...'}
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, code.length !== 8 && styles.buttonDisabled]}
          onPress={handleVerify}
          disabled={loading || code.length !== 8}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>ESTABLISH UPLINK</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.encryptedText}>Quantum Encrypted Tunnel Active</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050508', alignItems: 'center', justifyContent: 'center', padding: 20 },
  heroSection: { alignItems: 'center', marginBottom: 40 },
  heroTitle: { fontSize: 34, fontWeight: '800', color: '#fff', letterSpacing: -1 },
  heroSub: { fontSize: 14, color: '#888', marginTop: 4 },
  card: { backgroundColor: 'rgba(15,15,25,0.7)', borderRadius: 32, padding: 35, width: '100%', maxWidth: 440, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  aiGreeting: { backgroundColor: 'rgba(0, 242, 255, 0.05)', padding: 15, borderRadius: 12, borderLeftWidth: 3, borderLeftColor: '#00f2ff', marginBottom: 25 },
  aiText: { color: '#00f2ff', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  codeContainer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginBottom: 20 },
  codeBox: { width: 40, height: 50, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 12, textAlign: 'center', fontSize: 20, fontWeight: '800', color: '#fff' },
  codeBoxFilled: { borderColor: '#00f2ff', backgroundColor: 'rgba(0,242,255,0.1)' },
  binaryDisplay: { fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 9, color: '#00f2ff', marginBottom: 20, textAlign: 'center', opacity: 0.7 },
  error: { color: '#ff4444', fontSize: 12, marginBottom: 15, textAlign: 'center' },
  button: { width: '100%', padding: 18, borderRadius: 18, backgroundColor: '#00f2ff', alignItems: 'center', shadowColor: '#00f2ff', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.3, shadowRadius: 20, elevation: 10 },
  buttonDisabled: { opacity: 0.2, backgroundColor: '#444' },
  buttonText: { color: '#000', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  encryptedText: { fontSize: 10, color: '#444', textAlign: 'center', marginTop: 20, textTransform: 'uppercase', letterSpacing: 2 },
});
