// Web stub: the web build doesn't persist last-visited URLs, and
// expo-file-system's File/Paths APIs are native-only.
const BASE_URL = 'https://3ook.com';

export function saveLastURL(_url: string): void {}

export async function getInitialURL(): Promise<string> {
  return `${BASE_URL}?app=1`;
}
