import { vi } from 'vitest';

vi.mock('ollama-ai-provider', () => ({ ollama: vi.fn() }));
vi.mock('@ai-sdk/provider-utils', () => ({}));

// style-to-js depends on style-to-object ESM; stub both
vi.mock('style-to-object', () => ({ __esModule: true, default: () => ({}) }));
vi.mock('style-to-js', () => ({ __esModule: true, default: () => ({}) }));

// Multipart parser ESM stubs
vi.mock('@web3-storage/multipart-parser', () => ({}));
vi.mock('@web3-storage/multipart-parser/esm/src/index.js', () => ({}));

// Amazon Bedrock provider triggers @smithy → @aws-crypto → tslib ESM/CJS
// conflict. Mock the entire provider SDK to prevent the chain from loading.
vi.mock('@ai-sdk/amazon-bedrock', () => ({
  __esModule: true,
  createAmazonBedrock: vi.fn(() => vi.fn()),
}));

// AWS smithy core (ESM) stub to avoid missing module resolution
vi.mock('@smithy/core', () => ({
  __esModule: true,
  getSmithyContext: () => ({}),
}));
vi.mock('@smithy/core/dist-es/getSmithyContext', () => ({
  __esModule: true,
  default: () => ({}),
}));
vi.mock('@smithy/core/dist-es/index.js', () => ({
  __esModule: true,
  getSmithyContext: () => ({}),
}));

// AWS crypto CRC32 uses tslib via CJS require() which fails with ESM tslib
vi.mock('@aws-crypto/crc32', () => ({
  __esModule: true,
  Crc32: class { update() { return this; } digest() { return 0; } },
  crc32: () => 0,
}));

