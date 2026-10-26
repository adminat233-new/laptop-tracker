import { Alert, Linking } from 'react-native';
import { APP_VERSION_CODE, APP_VERSION_NAME } from '../config/appVersion';

export class UpdateService {
  private static checked = false;

  public static async checkForUpdate(serverUrl: string): Promise<void> {
    if (this.checked) return;
    this.checked = true;

    try {
      const cleanUrl = serverUrl.replace(/\/+$/, '');
      const res = await fetch(`${cleanUrl}/api/version`);
      if (!res.ok) return;

      const data = await res.json();
      if (!data || !data.version) return;

      const serverVersion: string = data.version;
      const parts = serverVersion.split('.').map((n: string) => parseInt(n, 10) || 0);
      const serverCode = (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);

      const currentParts = APP_VERSION_NAME.split('.').map((n: string) => parseInt(n, 10) || 0);
      const currentCode = (currentParts[0] || 0) * 10000 + (currentParts[1] || 0) * 100 + (currentParts[2] || 0);

      if (serverCode > currentCode || (data.versionCode && data.versionCode > APP_VERSION_CODE)) {
        const downloadUrl = data.apkUrl?.startsWith('http')
          ? data.apkUrl
          : `${cleanUrl}${data.apkUrl || '/FIND.apk'}`;
        const notes = data.releaseNotes || 'A new version with performance and security enhancements is available.';

        Alert.alert(
          `Update Available (v${serverVersion})`,
          `${notes}\n\nWould you like to download and install the update now?`,
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Update Now',
              onPress: () => {
                Linking.openURL(downloadUrl).catch(() => {});
              },
            },
          ]
        );
      }
    } catch {
      // Fail silently if network unreachable
    }
  }
}
