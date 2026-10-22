import type { NextConfig } from 'next'

// `@musecanvas/*` packages export raw `.ts` sources, so Next must compile them
// rather than treat them as prebuilt externals. `serverExternalPackages` is kept
// for the native/Node-only deps that must stay outside the bundle.
const config: NextConfig = {
  transpilePackages: [
    '@musecanvas/contracts',
    '@musecanvas/database',
    '@musecanvas/domain',
    '@musecanvas/providers',
  ],
  serverExternalPackages: ['pg', 'nodemailer', 'sharp'],
}
export default config
