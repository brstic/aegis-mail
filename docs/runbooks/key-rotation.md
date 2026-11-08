# Key rotation

`Envelope.rotate(tenantId, keyClass)` creates a new KEK version. New seals use it; old ciphertext stays readable through the version in its header. **Not built:** a job to re-seal old records under the new version, so rotation today limits future exposure only. Needed before a rotation can answer a compromise. Drill: rotate in staging, confirm old and new both open, measure re-seal time once built. Crypto-shredding is `DELETE FROM tenant_keys` plus process restart or `envelope.forget`, and is covered by tests.
