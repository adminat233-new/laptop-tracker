// ────────────────────────────────────────────────────────────────────────────
// React Native stub type declarations
// These allow TypeScript to compile the React Native mobile code in
// environments where the real @types/react-native isn't installed.
// ────────────────────────────────────────────────────────────────────────────

declare module 'react' {
  export function useState<T>(init: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useRef<T>(init: T): { current: T };
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: any[]): T;
  export function useMemo<T>(fn: () => T, deps: any[]): T;
  const React: any;
  export default React;
}

declare module 'react-native' {
  // Core components
  export const View: any;
  export const Text: any;
  export const TextInput: any;
  export type TextInput = any;
  export const TouchableOpacity: any;
  export const StyleSheet: {
    create: (styles: any) => any;
    flatten: (style: any) => any;
    absoluteFillObject: any;
    absoluteFill: any;
    hairlineWidth: number;
  };
  export const ScrollView: any;
  export const Dimensions: {
    get: (dim: string) => { width: number; height: number };
    addEventListener: (type: string, handler: any) => any;
    removeEventListener: (type: string, handler: any) => void;
  };
  export const Alert: {
    alert: (title: string, message?: string, buttons?: any[], options?: any) => void;
  };
  export const ActivityIndicator: any;
  export const Image: any;
  export const Modal: any;
  export const FlatList: any;
  export const StatusBar: any;
  export const KeyboardAvoidingView: any;
  export const Switch: any;
  export const Vibration: {
    vibrate: (pattern?: number | number[], repeat?: boolean) => void;
    cancel: () => void;
  };
  export const LogBox: {
    ignoreLogs: (logs: string[]) => void;
    ignoreAllLogs: (value?: boolean) => void;
  };
  export const NativeModules: any;
  export const Linking: {
    openURL: (url: string) => Promise<any>;
    canOpenURL: (url: string) => Promise<boolean>;
  };

  // Platform
  export const Platform: {
    OS: 'ios' | 'android' | 'web';
    Version: number;
    select: (options: any) => any;
  };

  // Permissions
  export const PermissionsAndroid: {
    PERMISSIONS: { [key: string]: string };
    RESULTS: { GRANTED: string; DENIED: string; NEVER_ASK_AGAIN: string };
    requestMultiple(perms: string[]): Promise<Record<string, string>>;
    request(perm: string, rationale?: any): Promise<string>;
    check(perm: string): Promise<boolean>;
  };

  // AppState
  export const AppState: {
    currentState: AppStateStatus;
    addEventListener: (type: string, handler: (state: AppStateStatus) => void) => any;
    removeEventListener: (type: string, handler: (state: AppStateStatus) => void) => void;
  };
  export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
}

declare module '@react-navigation/native' {
  export const NavigationContainer: any;
  export function useNavigation(): any;
  export function useRoute(): any;
}

declare module '@react-navigation/bottom-tabs' {
  export function createBottomTabNavigator(): any;
}

declare module 'react-native-maps' {
  export class MapView {
    animateToRegion(region: any, duration?: number): void;
    fitToCoordinates(coordinates?: any[], options?: any): void;
    [key: string]: any;
  }
  export default MapView;
  export const Marker: any;
  export const Circle: any;
  export const Polyline: any;
  export const Polygon: any;
  export const Callout: any;
}

declare const require: any;

declare module 'react-native-ble-plx' {
  export class BleManager {
    startDeviceScan(
      serviceUUIDs: string[] | null,
      options?: any,
      listener?: (error: any, device: Device | null) => void
    ): void;
    stopDeviceScan(): void;
    destroy(): void;
  }
  export interface Device {
    id: string;
    name?: string | null;
    rssi?: number;
    serviceUUIDs?: string[];
    localName?: string;
    manufacturerData?: string;
  }
}

declare module 'react-native-geolocation-service' {
  interface Position {
    coords: {
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude: number | null;
      altitudeAccuracy: number | null;
      heading: number | null;
      speed: number | null;
    };
    timestamp: number;
  }
  const Geolocation: {
    getCurrentPosition(
      success: (position: Position) => void,
      error?: (error: any) => void,
      options?: any
    ): void;
    watchPosition(
      success: (position: Position) => void,
      error?: (error: any) => void,
      options?: any
    ): number;
    clearWatch(watchId: number): void;
    stopObserving(): void;
  };
  export default Geolocation;
}

declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    multiRemove(keys: string[]): Promise<void>;
    clear(): Promise<void>;
    getAllKeys(): Promise<string[]>;
    multiGet(keys: string[]): Promise<[string, string | null][]>;
    multiSet(pairs: [string, string][]): Promise<void>;
  };
  export default AsyncStorage;
}

declare module 'react-native-background-actions' {
  const BackgroundService: {
    start(task: (taskData?: any) => Promise<void>, options: any): Promise<void>;
    stop(): Promise<void>;
    updateNotification(options: any): Promise<void>;
    isRunning(): boolean;
  };
  export default BackgroundService;
}

declare module 'react-native-wifi-reborn' {
  interface WifiEntry {
    SSID: string;
    BSSID: string;
    level: number;
    frequency: number;
    capabilities?: string;
  }
  const WifiManager: {
    loadWifiList(): Promise<WifiEntry[]>;
    getCurrentWifiSSID(): Promise<string>;
    connectToProtectedSSID(ssid: string, password: string, isWep: boolean): Promise<void>;
    forceWifiUsage(useWifi: boolean): Promise<void>;
    disconnect(): void;
  };
  export default WifiManager;
}

declare module 'react-native-device-info' {
  const DeviceInfo: {
    getModel(): Promise<string>;
    getBrand(): Promise<string>;
    getSystemName(): Promise<string>;
    getSystemVersion(): Promise<string>;
    getBatteryLevel(): Promise<number>;
    getTotalMemory(): Promise<number>;
    getUniqueId(): Promise<string>;
    getDeviceName(): Promise<string>;
    getVersion(): string;
    getBuildNumber(): string;
    getDiskSpaceUsed?(): Promise<number>;
  };
  export default DeviceInfo;
}

declare module 'react-native-sound' {
  class Sound {
    static MAIN_BUNDLE: string;
    static setCategory(category: string): void;
    constructor(filename: string, basePath: string, onError?: (error: any) => void);
    play(onEnd?: (success: boolean) => void): void;
    stop(onStop?: () => void): void;
    release(): void;
    setVolume(value: number): Sound;
    setNumberOfLoops(value: number): Sound;
    getCurrentTime(callback: (seconds: number, isPlaying: boolean) => void): void;
    getDuration(): number;
    isPlaying(): boolean;
  }
  export default Sound;
}
