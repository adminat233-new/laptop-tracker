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
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0f" />
      <View style={styles.card}>
        <View style={styles.iconContainer}>
          <Text style={styles.icon}>📱</Text>
        </View>
        <Text style={styles.title}>Connect to Laptop</Text>
        <Text style={styles.subtitle}>Enter 8-character code from laptop</Text>

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
            />
          ))}
        </View>

        <Text style={styles.binaryDisplay}>
          {code.length > 0 ? 'Binary: ' + code.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ') : 'Binary: --'}
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
            <Text style={styles.buttonText}>Verify & Connect</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 24, padding: 30, width: '100%', maxWidth: 400, alignItems: 'center' },
  iconContainer: { width: 90, height: 90, backgroundColor: '#7c3aed', borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  icon: { fontSize: 42 },
  title: { fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 6 },
  subtitle: { fontSize: 12, color: '#888', marginBottom: 20 },
  codeContainer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginBottom: 16 },
  codeBox: { width: 42, height: 52, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 10, textAlign: 'center', fontSize: 22, fontWeight: '700', color: '#fff' },
  codeBoxFilled: { borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,0.15)' },
  binaryDisplay: { fontFamily: 'monospace', fontSize: 10, color: '#00d4ff', marginBottom: 12, textAlign: 'center' },
  error: { color: '#ff4444', fontSize: 12, marginBottom: 12, textAlign: 'center' },
  button: { width: '100%', padding: 16, borderRadius: 14, backgroundColor: '#00d4ff', alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
