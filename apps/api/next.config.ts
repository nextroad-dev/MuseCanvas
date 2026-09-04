import type { NextConfig } from 'next'

const config: NextConfig = { serverExternalPackages: ['pg', 'nodemailer', 'sharp'] }
export default config
