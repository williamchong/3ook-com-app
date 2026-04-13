import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { BridgeHandlerMap } from './bridge-dispatcher';

function validateFilename(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) throw new Error('Missing filename');
  if (/[/\\]/.test(raw)) throw new Error('Filename must not contain path separators');
  return raw;
}

async function handleFileDownloadData(msg: Record<string, unknown>): Promise<void> {
  const filename = validateFilename(msg.filename);
  const { base64 } = msg;
  if (typeof base64 !== 'string' || !base64) throw new Error('Missing base64');

  const file = new File(Paths.cache, filename);
  file.write(base64, { encoding: 'base64' });

  await Sharing.shareAsync(file.uri);
}

export function getDownloadHandlers(): BridgeHandlerMap {
  return {
    fileDownloadData: handleFileDownloadData,
  };
}
