export {
  atomicWrite,
  DEFAULT_SCRYPT,
  DEVICE_KEY_BYTES,
  defaultKeyPath,
  defaultVaultPath,
  EncryptedFileVault,
  FILE_VAULT_VERSION,
  type FileVaultMode,
  type FileVaultOptions,
  type ScryptParams,
} from "./file.ts";
export {
  DEFAULT_KEYRING_SERVICE,
  KEYRING_CHUNK_CHARS,
  KEYRING_INDEX_ACCOUNT,
  type KeyringDetection,
  type KeyringEntryFactory,
  type KeyringEntryLike,
  KeyringVault,
  type KeyringVaultOptions,
  keyringServiceName,
  nativeKeyringEntries,
} from "./keyring.ts";
export { MemoryVault } from "./memory.ts";
export { type OpenVaultOptions, openVault, VAULT_BACKEND_ENV } from "./open.ts";
export {
  formatSecretRef,
  isSecretRef,
  MIN_REDACT_LENGTH,
  parseSecretRef,
  type ResolveOptions,
  redactValues,
  resolveSecretRefs,
  SECRET_PREFIX,
  SecretResolver,
} from "./refs.ts";
export {
  assertSecretName,
  assertSecretValue,
  isValidSecretName,
  MAX_SECRET_VALUE_LENGTH,
  SECRET_NAME_PATTERN,
  type Vault,
  type VaultBackend,
} from "./types.ts";
