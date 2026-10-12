import { fileURLToPath } from 'node:url';

const coverageBuild = process.env.LIBRARIAN_COVERAGE_BUILD === '1';

const nextConfig = {
  distDir: process.env.LIBRARIAN_NEXT_DIST_DIR ?? '.next',
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  serverExternalPackages: ['@fumadocs/local-md', 'shiki'],
  productionBrowserSourceMaps: coverageBuild,
  // Keep coverage-build function boundaries; normal production retains minification.
  // Avoid Windows EPERM races while Next workers create route directories under .next.
  experimental: { cpus: 1, serverSourceMaps: coverageBuild, serverMinification: !coverageBuild },
  webpack(config) {
    // Pre-loaders execute right to left, so application code is instrumented before bundling.
    if (coverageBuild) config.module.rules.push({
      test: /\.[cm]?[jt]sx?$/, enforce: 'pre',
      include: ['app', 'lib', 'components', 'auth.ts', 'instrumentation.ts', 'mdx-components.tsx'].map(path => fileURLToPath(new URL(`./${path}`, import.meta.url))),
      use: [fileURLToPath(new URL('./scripts/coverage-loader.mjs', import.meta.url))],
    });
    return config;
  },
};

export default nextConfig;
