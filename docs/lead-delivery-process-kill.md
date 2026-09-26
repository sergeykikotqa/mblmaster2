# MBL-R04: process-kill delivery fault injection

Run `npm run check:lead-process-kills` to execute two deterministic, local failure scenarios against an isolated Redis container and a synthetic loopback webhook receiver.

- **R04-1:** the child worker is killed after Redis confirms its delivery claim but while a test-only fetch barrier still prevents the HTTP POST.
- **R04-2:** the child worker is killed after the receiver has accepted the signed POST but before `deliverLeadWebhook()` returns and before the worker can commit delivered state or its fence.

The harness starts each worker in a separate Node process and reports its exact PID over IPC. Barriers are implemented only in `scripts/lead-delivery-process-kill-worker-child.mjs`; production worker, store, webhook and API modules are not instrumented.

Each run uses a unique `mbl-r04-*` Compose project, unique Redis prefix, dedicated named volume and random loopback ports. Cleanup targets only those generated identifiers. The harness never runs global Docker cleanup commands.

The test proves process termination and recovery for the two specified windows. It does not prove behavior for OS power loss, Redis data loss, an external webhook implementation, or the complete production release gate.
