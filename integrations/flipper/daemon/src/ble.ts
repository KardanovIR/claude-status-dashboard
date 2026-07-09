// BLE central: finds the Flipper, connects to its built-in serial service, and
// writes frames to the RX characteristic. On macOS noble uses CoreBluetooth,
// which performs pairing on demand the first time we access the encrypted RX
// char — the Flipper shows a PIN to confirm.

import noble, { type Characteristic, type Peripheral } from '@abandonware/noble';
import { config } from './config.js';

// Flipper serial service / characteristics, as noble UUIDs (lowercase, no dashes).
const SERVICE_UUID = '8fe5b3d52e7f4a982a487acc60fe0000';
const RX_UUID = '19ed82aeed214c9d4145228e61fe0000'; // host writes -> Flipper receives
const TX_UUID = '19ed82aeed214c9d4145228e62fe0000'; // Flipper notifies -> host (debug)

const CHUNK = 20; // BLE serial char value max; keep writes small
const INTER_CHUNK_MS = 15;

export class BleLink {
  private peripheral: Peripheral | null = null;
  private rx: Characteristic | null = null;
  private lastFrame: Buffer | null = null;
  private connecting = false;
  private writing = Promise.resolve();

  start(): void {
    noble.on('stateChange', (state: string) => {
      console.log(`[ble] adapter state: ${state}`);
      if (state === 'poweredOn') void this.scan();
      else void noble.stopScanningAsync().catch(() => {});
    });
    noble.on('discover', (p: Peripheral) => this.onDiscover(p));
    if (noble.state === 'poweredOn') void this.scan();
  }

  // Cache the latest frame and push it if connected; resent automatically on
  // (re)connect so the Flipper always shows current state.
  send(frame: Buffer): void {
    this.lastFrame = frame;
    if (this.rx) this.writeFrame(frame);
  }

  private async scan(): Promise<void> {
    try {
      await noble.startScanningAsync([], false);
      console.log('[ble] scanning for Flipper…');
    } catch (err) {
      console.warn(`[ble] scan failed: ${(err as Error).message}`);
    }
  }

  private isFlipper(p: Peripheral): boolean {
    const name = p.advertisement?.localName || '';
    if (config.flipperName) return name === config.flipperName;
    return /^Flipper /i.test(name);
  }

  private async onDiscover(p: Peripheral): Promise<void> {
    if (this.connecting || this.peripheral) return;
    if (!this.isFlipper(p)) return;

    this.connecting = true;
    const name = p.advertisement?.localName || p.id;
    console.log(`[ble] found ${name} (${p.id}); connecting…`);
    try {
      await noble.stopScanningAsync();
      await p.connectAsync();
      this.peripheral = p;
      p.once('disconnect', () => this.onDisconnect());

      const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync(
        [SERVICE_UUID],
        [RX_UUID, TX_UUID],
      );
      this.rx = characteristics.find((c) => c.uuid === RX_UUID) ?? null;
      const tx = characteristics.find((c) => c.uuid === TX_UUID) ?? null;

      if (!this.rx) throw new Error('serial RX characteristic not found');
      console.log(`[ble] connected to ${name}; serial RX ready`);

      if (tx) {
        tx.on('data', (data: Buffer) => {
          const s = data.toString('utf8').trim();
          if (s) console.log(`[ble] flipper -> host: ${s}`);
        });
        await tx.subscribeAsync().catch(() => {});
      }

      // Pushing the first frame triggers pairing (PIN on the Flipper) if needed.
      if (this.lastFrame) this.writeFrame(this.lastFrame);
    } catch (err) {
      console.warn(`[ble] connect failed: ${(err as Error).message}`);
      try {
        await p.disconnectAsync();
      } catch {
        /* ignore */
      }
      this.peripheral = null;
      this.rx = null;
      void this.scan();
    } finally {
      this.connecting = false;
    }
  }

  private onDisconnect(): void {
    console.warn('[ble] disconnected; rescanning…');
    this.peripheral = null;
    this.rx = null;
    void this.scan();
  }

  // Serialize writes so chunks never interleave between frames.
  private writeFrame(frame: Buffer): void {
    const rx = this.rx;
    if (!rx) return;
    const withoutResponse = !rx.properties.includes('write');
    this.writing = this.writing
      .then(async () => {
        for (let i = 0; i < frame.length; i += CHUNK) {
          if (this.rx !== rx) return; // disconnected mid-write
          await rx.writeAsync(frame.subarray(i, i + CHUNK), withoutResponse);
          if (i + CHUNK < frame.length) await delay(INTER_CHUNK_MS);
        }
      })
      .catch((err) => {
        console.warn(`[ble] write failed: ${(err as Error).message}`);
      });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
