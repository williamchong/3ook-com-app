import * as Linking from 'expo-linking';

const DEEP_LINK_SCHEME_RE =
  /^(mailto:|tel:|wc:|metamask:|cbwallet:|rainbow:|trust:)/;

const WALLET_UNIVERSAL_LINK_PREFIXES = [
  'https://metamask.app.link/',
  'https://go.cb-w.com/',
  'https://link.trustwallet.com/',
];

/** Returns true for URLs that should be opened by the OS rather than loaded
 *  inside the WebView. Only explicitly allowed schemes and known wallet
 *  universal links are treated as deep links. */
export function isDeepLink(url: string): boolean {
  return (
    DEEP_LINK_SCHEME_RE.test(url) ||
    WALLET_UNIVERSAL_LINK_PREFIXES.some((prefix) => url.startsWith(prefix))
  );
}

export async function openDeepLink(url: string): Promise<void> {
  await Linking.openURL(url);
}
