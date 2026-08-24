const { exec, spawn } = require('child_process');
const path = require('path');
const os = require('os');

class AlarmSystem {
  constructor() {
    this.activeAlarms = new Map();
    this.alarmProcesses = new Map();
  }

  async triggerAlarm(type, duration = 30) {
    // Stop any existing alarm of same type
    if (this.alarmProcesses.has(type)) {
      this.stopAlarm(type);
    }

    switch (type) {
      case 'siren':
        return this.playSiren(duration);
      case 'alarm':
        return this.playAlarm(duration);
      case 'noise':
        return this.playNoise(duration);
      case 'sensor':
        return this.triggerSensorAlarm(duration);
      case 'all':
        return this.triggerAllAlarms(duration);
      default:
        throw new Error(`Unknown alarm type: ${type}`);
    }
  }

  playSiren(duration) {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Windows: Use PowerShell to generate siren sounds
        const script = `
          Add-Type -AssemblyName System.Media
          $siren = New-Object System.Media.SoundPlayer
          
          # Generate siren frequencies
          $frequencies = @(800, 1000, 1200, 1400, 1200, 1000, 800)
          $sampleRate = 44100
          $duration = ${duration}
          
          # Create WAV file with siren
          $wav = New-Object System.IO.MemoryStream
          $writer = New-Object System.IO.BinaryWriter($wav)
          
          # WAV header
          $writer.Write([byte[]]@(0x52, 0x49, 0x46, 0x46))
          $writer.Write([int]0)
          $writer.Write([byte[]]@(0x57, 0x41, 0x56, 0x45))
          $writer.Write([byte[]]@(0x66, 0x6D, 0x74, 0x20))
          $writer.Write([int]16)
          $writer.Write([short]1)
          $writer.Write([short]1)
          $writer.Write([int]$sampleRate)
          $writer.Write([int]($sampleRate * 2))
          $writer.Write([short]2)
          $writer.Write([short]16)
          $writer.Write([byte[]]@(0x64, 0x61, 0x74, 0x61))
          
          $dataSize = $sampleRate * $duration * 2
          $writer.Write([int]$dataSize)
          
          for ($i = 0; $i -lt $sampleRate * $duration; $i++) {
            $time = $i / $sampleRate
            $freqIndex = [Math]::Floor(($time * 4) % $frequencies.Length)
            $freq = $frequencies[$freqIndex]
            $sample = [Math]::Sin(2 * [Math]::PI * $freq * $time) * 32767 * 0.8
            $writer.Write([short]$sample)
          }
          
          $wavPath = "$env:TEMP\\siren.wav"
          [System.IO.File]::WriteAllBytes($wavPath, $wav.ToArray())
          
          $siren.SoundLocation = $wavPath
          $siren.PlaySync()
        `;

        const proc = spawn('powershell', ['-Command', script], {
          detached: true,
          stdio: 'ignore'
        });

        this.alarmProcesses.set('siren', proc);
        proc.on('error', reject);
        proc.on('exit', () => {
          this.alarmProcesses.delete('siren');
          resolve();
        });

        setTimeout(() => this.stopAlarm('siren'), duration * 1000);
        resolve({ type: 'siren', duration, status: 'playing' });

      } else {
        // Linux/Mac: Use aplay or sox
        exec(`python3 -c "
import numpy as np
import sounddevice as sd
duration = ${duration}
sample_rate = 44100
t = np.linspace(0, duration, sample_rate * duration)
frequencies = np.interp(t % 4, [0, 1, 2, 3, 4], [800, 1000, 1200, 1400, 800])
signal = np.sin(2 * np.pi * frequencies * t) * 0.8
sd.play(signal.astype(np.float32), sample_rate)
sd.wait()
"`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }
    });
  }

  playAlarm(duration) {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Use Windows beep sounds
        const script = `
          for ($i = 0; $i -lt ${Math.floor(duration / 0.5)}; $i++) {
            [Console]::Beep(1000, 200)
            [Console]::Beep(800, 200)
            Start-Sleep -Milliseconds 100
          }
        `;

        const proc = spawn('powershell', ['-Command', script], {
          detached: true,
          stdio: 'ignore'
        });

        this.alarmProcesses.set('alarm', proc);
        proc.on('error', reject);
        proc.on('exit', () => {
          this.alarmProcesses.delete('alarm');
          resolve();
        });

        resolve({ type: 'alarm', duration, status: 'playing' });

      } else {
        exec(`for i in $(seq 1 $((duration * 4))); do printf '\\a'; sleep 0.25; done`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }
    });
  }

  playNoise(duration) {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        const script = `
          Add-Type -AssemblyName System.Media
          $sampleRate = 44100
          $samples = $sampleRate * ${duration}
          $random = New-Object System.Random
          
          $wav = New-Object System.IO.MemoryStream
          $writer = New-Object System.IO.BinaryWriter($wav)
          
          # WAV header
          $writer.Write([byte[]]@(0x52, 0x49, 0x46, 0x46))
          $writer.Write([int]0)
          $writer.Write([byte[]]@(0x57, 0x41, 0x56, 0x45))
          $writer.Write([byte[]]@(0x66, 0x6D, 0x74, 0x20))
          $writer.Write([int]16)
          $writer.Write([short]1)
          $writer.Write([short]1)
          $writer.Write([int]$sampleRate)
          $writer.Write([int]($sampleRate * 2))
          $writer.Write([short]2)
          $writer.Write([short]16)
          $writer.Write([byte[]]@(0x64, 0x61, 0x74, 0x61))
          
          $dataSize = $samples * 2
          $writer.Write([int]$dataSize)
          
          for ($i = 0; $i -lt $samples; $i++) {
            $sample = ($random.NextDouble() * 2 - 1) * 32767 * 0.5
            $writer.Write([short]$sample)
          }
          
          $noisePath = "$env:TEMP\\noise.wav"
          [System.IO.File]::WriteAllBytes($noisePath, $wav.ToArray())
          
          $player = New-Object System.Media.SoundPlayer
          $player.SoundLocation = $noisePath
          $player.PlaySync()
        `;

        const proc = spawn('powershell', ['-Command', script], {
          detached: true,
          stdio: 'ignore'
        });

        this.alarmProcesses.set('noise', proc);
        proc.on('error', reject);
        proc.on('exit', () => {
          this.alarmProcesses.delete('noise');
          resolve();
        });

        resolve({ type: 'noise', duration, status: 'playing' });

      } else {
        exec(`python3 -c "
import numpy as np
import sounddevice as sd
duration = ${duration}
sample_rate = 44100
noise = np.random.randn(sample_rate * duration) * 0.5
sd.play(noise.astype(np.float32), sample_rate)
sd.wait()
"`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }
    });
  }

  triggerSensorAlarm(duration) {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Trigger multiple alarm types for sensor alarm
        const script = `
          Add-Type -AssemblyName System.Windows.Forms
          
          # Flash screen effect
          for ($i = 0; $i -lt ${Math.floor(duration / 2)}; $i++) {
            [Console]::Beep(1500, 100)
            Start-Sleep -Milliseconds 50
            [Console]::Beep(1200, 100)
            Start-Sleep -Milliseconds 50
            [Console]::Beep(900, 100)
            Start-Sleep -Milliseconds 50
            [Console]::Beep(1200, 100)
            Start-Sleep -Milliseconds 50
          }
        `;

        const proc = spawn('powershell', ['-Command', script], {
          detached: true,
          stdio: 'ignore'
        });

        this.alarmProcesses.set('sensor', proc);
        proc.on('error', reject);
        proc.on('exit', () => {
          this.alarmProcesses.delete('sensor');
          resolve();
        });

        resolve({ type: 'sensor', duration, status: 'triggered' });

      } else {
        exec(`python3 -c "
import numpy as np
import sounddevice as sd
duration = ${duration}
sample_rate = 44100
t = np.linspace(0, duration, sample_rate * duration)
# Multi-frequency alarm
signal = np.sin(2 * np.pi * 1500 * t) * 0.4
signal += np.sin(2 * np.pi * 1200 * t) * 0.3
signal += np.sin(2 * np.pi * 900 * t) * 0.3
# Add pulsing effect
pulse = np.abs(np.sin(2 * np.pi * 2 * t))
signal *= pulse
sd.play(signal.astype(np.float32), sample_rate)
sd.wait()
"`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }
    });
  }

  async triggerAllAlarms(duration) {
    await Promise.all([
      this.playSiren(duration),
      this.playAlarm(duration),
      this.playNoise(duration)
    ]);
    return { type: 'all', duration, status: 'triggered' };
  }

  stopAlarm(type) {
    const proc = this.alarmProcesses.get(type);
    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        // Process might already be dead
      }
      this.alarmProcesses.delete(type);
    }

    if (process.platform === 'win32') {
      exec('taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq *siren*" /FI "WINDOWTITLE eq *noise*" 2>nul');
    }
  }

  stopAllAlarms() {
    for (const [type] of this.alarmProcesses) {
      this.stopAlarm(type);
    }
    this.alarmProcesses.clear();
  }

  getActiveAlarms() {
    return Array.from(this.alarmProcesses.keys());
  }
}

module.exports = new AlarmSystem();
