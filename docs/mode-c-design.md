# Mode C: attested confidential processing (design, not built)

**Status: design only. Nothing here exists in the product, and nothing may claim it does.** No code path, screen or page offers Mode C as available. It's the separate design review Mode C needs before anything is built, because it must not ship as a checkbox. No reviewer has read it yet, and no number in it is measured.

## What it would have to prove
Mode A's limit is plain: the operator can read mail while it's processed, and anyone with deploy rights could change the code that does it. Mode C is only worth building if it can truthfully say:

> Plaintext mail is only available inside a measured workload, and the keys needed to read it are only released to a workload whose measurement matches a policy the operator can't quietly change.

If any step of that fails, the honest answer is to keep calling it Mode A.

## What a TEE doesn't fix
- **Whoever controls the measurement policy controls the outcome.** If we approve measurements and also run the key release service, we can approve a build that exfiltrates mail. This is the central problem, and hardware doesn't solve it.
- **The mailbox tokens.** Whoever holds a Gmail OAuth refresh token can read the mailbox directly, with no TEE involved. Tokens must be sealed so only the attested workload can use them, or the claim is empty.
- **Everything outside the boundary.** Hosted Claude calls and any external scanner get plaintext outside it. They must be off, or inside the boundary, or disclosed on the claim itself. Today's `AnthropicProvider` would not qualify.
- **Side channels and rollback.** SEV-SNP and TDX exclude the host from memory, not from timing, access patterns or traffic volume. A host can also replay old sealed state.
- **Container isolation isn't this.** Running in a container, a VM or a dedicated host gives no attestation. Only CPU-rooted evidence counts.

## Proposed shape
| Part | Choice | Why |
|---|---|---|
| Hardware | Confidential VMs with SEV-SNP or TDX, on AWS or GCP | Runs the existing Node worker without a rewrite. Nitro Enclaves would need a smaller purpose-built process and has no direct network, which suits a later hardening step |
| Workload | Only the analysis and sync worker, in a separate image with no shell or SSH, built reproducibly and signed | The web process serves code to browsers and can't be measured in a way a user could check, so it never receives plaintext in this mode |
| Key release | Tenant KEK wrap key held in a KMS whose policy releases it only against attestation evidence | Replaces today's `AwsKmsProvider`, where any process with IAM access can unwrap |
| Verifier | Run by a party independent of the operator, or by the organization whose mail it is | Without this, the key-release row above is only as trustworthy as the operator |
| Measurement policy | Transparency log, with a delay before a new measurement can receive keys, and notification of users | Lets users see and object to a new build before it can read their mail |
| Web reads | Web gets only ciphertext. Reads decrypt in the browser with a key released to the user, or through a narrow attested endpoint | Hardest open problem. See below |
| Search | Inside the boundary only. The plaintext `message_search` index can't exist in this mode | The word index is readable from a database dump, so it contradicts the claim |

## Open problems that could sink it
1. **Showing mail to the user.** The reading UI needs plaintext somewhere. A narrow attested read endpoint still serves code from a server we control. Client-side decryption means the Mode B limit, where a malicious deploy can capture the key.
2. **Provider tokens.** Whether a refresh token can be kept truly inside the boundary through OAuth's redirect flow, which passes through our web tier.
3. **Model quality.** A model small enough to run inside the boundary on CPU is much weaker than a hosted one. GPU confidential computing exists, with limited availability.
4. **Updates.** Each security fix is a new measurement. A delay protects users but also slows emergency fixes.
5. **Cost.** Unknown. Nobody should promise a price for this before a pilot.

## Acceptance gates
All must pass before any page may describe Mode C as available.
1. A hostile operator test: someone with full cloud admin, deploy rights and database access tries to read a canary message, and fails, or the failure is described on the claim.
2. An unapproved build, a debug-enabled image and a replayed measurement are each refused keys, on real hardware.
3. The verifier is independent, in writing, and its release decisions are logged somewhere the operator can't edit.
4. No plaintext outside the boundary: a network and storage capture of a full mail cycle finds none, apart from what the claim discloses.
5. Independent cryptographic and side-channel review, with findings published.
6. The Privacy Center matrix states exactly what remains possible, reviewed by counsel.

## What's needed to start
A cloud account with confidential VM access, a chosen independent verifier, and a decision on open problem 1. None of this can be tested in this repository without that hardware, so the current build doesn't attempt it. Building a software stand-in would produce exactly the deceptive checkbox the prompt forbids.
