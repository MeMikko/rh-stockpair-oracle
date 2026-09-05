// Browser entry for the WalletConnect provider.
//
// Bundled at runtime by src/admin/vendor.ts and served from this origin. The
// published UMD build cannot be used directly: its browser branch expects
// viem, lit, bs58, qrcode and seven more as pre-existing globals, so loading
// dist/index.umd.js in a page gives a provider whose dependencies are all
// undefined.
export { EthereumProvider } from '@walletconnect/ethereum-provider';
