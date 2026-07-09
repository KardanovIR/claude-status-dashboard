// Minimal ambient declaration for the bits of @abandonware/noble we use.
// The package's bundled types are incomplete/inconsistent across versions, so
// we declare just our surface here for a clean typecheck.
declare module '@abandonware/noble' {
  import { EventEmitter } from 'events';

  export interface Characteristic extends EventEmitter {
    uuid: string;
    properties: string[];
    writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
    subscribeAsync(): Promise<void>;
  }

  export interface Service {
    uuid: string;
    characteristics: Characteristic[];
  }

  export interface Advertisement {
    localName?: string;
    serviceUuids?: string[];
  }

  export interface Peripheral extends EventEmitter {
    id: string;
    address: string;
    advertisement: Advertisement;
    state: string;
    connectAsync(): Promise<void>;
    disconnectAsync(): Promise<void>;
    discoverSomeServicesAndCharacteristicsAsync(
      serviceUuids: string[],
      characteristicUuids: string[],
    ): Promise<{ services: Service[]; characteristics: Characteristic[] }>;
  }

  interface Noble extends EventEmitter {
    state: string;
    startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
    stopScanningAsync(): Promise<void>;
  }

  const noble: Noble;
  export default noble;
}
